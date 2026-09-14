/** Finding the paved surface in a site plan SVG.
 *
 * Two approaches, converging on the same confirm step:
 *   1. pre-tagged  - data-role="paving", or cedarOS's fill #4D4D4D
 *   2. shape rank  - works on any SVG, no metadata at all
 *
 * Approach 2 is the one that matters: it is what lets the tool accept a plan
 * from anywhere. Approach 1 only pre-selects, so a missing or changed tag costs
 * a click rather than the whole result. */

import { overlaps_plot, read_plot_boundary, type PlotBoundary } from "./plot-line";
import { SHAPE_SELECTOR } from "./svg";

export type Candidate = {
	/** Index into the SVG's own path order, used to highlight the element. */
	index: number;
	points: [number, number][];
	fill: string;
	/** Real-world square feet, once a scale is known. Falls back to user units. */
	area: number;
	perimeter: number;
	width: number;
	height: number;
	/** area / bounding-box area. Informational; it does not enter the score. */
	fill_ratio: number;
	/** 2 x area / perimeter - the mean width of a corridor. */
	mean_width: number;
	/** sqrt(area) x perimeter: long and thin for its size. See detect_paving. */
	score: number;
	/** Polygon area centroid, in SVG user units. Anchors the confirm popup. */
	centroid: [number, number];
	/** Overlaps the property boundary, when the drawing has one. True for every
	 * candidate when it does not - absent a boundary, nothing is off-site. */
	on_site: boolean;
};

export type Detection = {
	candidates: Candidate[];
	/** Highest-ranked candidate, or the tagged one when the export cooperated. */
	best: Candidate | null;
	method: "tagged" | "ranked" | "none";
	/** The property boundary read off the drawing, or null when it has none. */
	plot: PlotBoundary | null;
};

/** cedarOS sets this on the drive polyline (POLYLINE_STYLES.drive in its exporter),
 * so it is a guarantee for that source rather than a colour that happens to match. */
const CEDAR_DRIVE_FILL = "#4d4d4d";

/** A white fill on a white sheet is a mask, not a surface. The exporter draws
 * neighbouring parcels and context buildings as white polygons, many of them off
 * the sheet, and none of them is paving: of the 6,207 shapes that outranked a
 * tagged drive in the corpus census, 6,016 were white. They stay in the list -
 * the list is also what a click can select, and a white parcel is a legitimate
 * thing to point at - they just rank after everything drawn in a colour. */
const WHITE_FILL = "#ffffff";

/** Below this, a filled region is a symbol or an artefact rather than paving.
 *
 * In SQUARE FEET when the file declares a scale. With no scale there is nothing
 * to convert with, so the same number is applied to the drawing's own units -
 * a different threshold, deliberately, because the alternative is inventing a
 * conversion. It only ever discards specks, so the difference does not decide
 * anything: across the 36 declared-scale plans, 915 filled shapes, the two
 * thresholds disagree about none of them and neither discards a single shape. */
const MIN_AREA = 5;

/** NO SITE BOUNDARY IS APPLIED. Every filled region on the sheet is a candidate
 * and every one is clickable, including a neighbour's building across the road.
 *
 * There was a proximity rule here - within twice the drive's own width of the
 * drive - and it was invented, not measured from anything the drawing states.
 * It also could not help the ranking, since it needs the drive in order to say
 * what is near the drive.
 *
 * The plans do draw their plot lines: closed, unfilled, 5-20 vertex outlines
 * stroked #D4D2D2, present in 410 of the 450 plans with a tagged drive. They
 * are unusable as a site boundary because the subject parcel and the
 * neighbouring parcels are drawn identically - same stroke, same weight, no
 * tag - so nothing in the file says which one is the site. One older export
 * did label them (data-name="contextParcels", 24 files), which shows the
 * information exists upstream and simply is not exported. Until it is, or
 * until the user draws the boundary, guessing which outline is the site would
 * be the same mistake as guessing the scale: a confident wrong answer with
 * nothing on screen to show it is wrong. */

function ring_metrics(points: [number, number][])
{
	let twice_area = 0;
	let perimeter = 0;
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < points.length; i++)
	{
		const [x1, y1] = points[i];
		const [x2, y2] = points[(i + 1) % points.length];
		const cross = x1 * y2 - x2 * y1;
		twice_area += cross;
		cx += (x1 + x2) * cross;
		cy += (y1 + y2) * cross;
		perimeter += Math.hypot(x2 - x1, y2 - y1);
	}
	const centroid: [number, number] =
		twice_area !== 0
			? [cx / (3 * twice_area), cy / (3 * twice_area)]
			: [points[0][0], points[0][1]];
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return {
		area: Math.abs(twice_area / 2),
		perimeter,
		width: Math.max(...xs) - Math.min(...xs),
		height: Math.max(...ys) - Math.min(...ys),
		centroid,
	};
}

/** Only straight-line paths are read. The exporters we have seen tessellate
 * everything, and a curve command would need flattening before these metrics
 * mean anything - better to skip than to measure it wrong. */
function read_ring(d: string): [number, number][] | null
{
	if (!/z/i.test(d)) return null;
	if (/[^MLZmlz0-9\s.,+-]/.test(d)) return null;
	const nums = d.match(/-?\d+\.?\d*(?:e[+-]?\d+)?/gi)?.map(Number);
	if (!nums || nums.length < 6) return null;
	const points: [number, number][] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
	return points.length >= 3 ? points : null;
}

/** <polyline> and <polygon> carry bare coordinate pairs, no commands. A polygon
 * is closed by definition, and a polyline is closed by the renderer whenever it
 * is filled - and unfilled shapes never reach here - so both read as rings. The
 * exporter behind option_4 draws its whole drive this way. */
function read_points(raw: string): [number, number][] | null
{
	const nums = raw.match(/-?\d+\.?\d*(?:e[+-]?\d+)?/gi)?.map(Number);
	if (!nums || nums.length < 6) return null;
	const points: [number, number][] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
	return points.length >= 3 ? points : null;
}

export function detect_paving(svg: SVGSVGElement, px_per_ft: number | null): Detection
{
	const scale = px_per_ft && px_per_ft > 0 ? px_per_ft : 1;
	const shapes = [...svg.querySelectorAll(SHAPE_SELECTOR)];
	const candidates: Candidate[] = [];
	let tagged: Candidate | null = null;

	shapes.forEach((path, index) =>
	{
		// By now read_svg has written every effective colour onto the element itself,
		// so the attribute is the truth whether the file used attributes or classes.
		const fill = (path.getAttribute("fill") ?? "none").trim();
		if (fill.toLowerCase() === "none") return;
		const points =
			path.nodeName.toLowerCase() === "path"
				? read_ring(path.getAttribute("d") ?? "")
				: read_points(path.getAttribute("points") ?? "");
		if (!points) return;

		const m = ring_metrics(points);
		const area = m.area / (scale * scale);
		if (area < MIN_AREA) return;

		const width = m.width / scale;
		const height = m.height / scale;
		const perimeter = m.perimeter / scale;
		const box = width * height;
		const fill_ratio = box > 0 ? area / box : 1;

		const candidate: Candidate = {
			index,
			points,
			fill,
			area,
			perimeter,
			width,
			height,
			fill_ratio,
			mean_width: perimeter > 0 ? (2 * area) / perimeter : 0,
			// Long and thin for its size. The first score, area / fill_ratio, reduces
			// algebraically to width * height - the bounding box - so it was "biggest
			// box wins", and the sparseness it meant to reward never entered it.
			// Perimeter is the corridor signal; sqrt(area) keeps a hairline strip with
			// a long outline from beating the drive on perimeter alone. Over the 450
			// tagged plans in the census, with white demoted: the box put the drive
			// first on 337, perimeter on 366, sqrt(area) * perimeter on 374 - the two
			// it still misses are a lake and a building, each larger than its drive.
			score: Math.sqrt(area) * perimeter,
			centroid: m.centroid,
			on_site: true,
		};
		candidates.push(candidate);

		// The drive colour is not unique to the drive: option_4 paints its 54 car
		// symbols the same #4D4D4D, ~44 sq ft each, and they come after the drive in
		// the file. Last-one-wins picked a car. The drive is the largest thing drawn
		// in its own colour, which holds by construction rather than by luck.
		const role = path.getAttribute("data-role");
		if (role === "paving" || fill.toLowerCase() === CEDAR_DRIVE_FILL)
		{
			if (!tagged || candidate.area > tagged.area) tagged = candidate;
		}
	});

	candidates.sort(
		(a, b) =>
			Number(a.fill.toLowerCase() === WHITE_FILL) - Number(b.fill.toLowerCase() === WHITE_FILL) ||
			b.score - a.score
	);

	const best: Candidate | null = tagged ?? candidates[0] ?? null;
	const method = tagged ? "tagged" : best ? "ranked" : "none";
	if (!best) return { candidates, best: null, method: "none", plot: null };

	// The boundary is anchored on the paving we just found, so it can never put
	// that paving off-site. Everything else is tested against it.
	const plot = read_plot_boundary(svg, best.points);
	if (plot)
	{
		for (const candidate of candidates)
		{
			candidate.on_site = candidate === best || overlaps_plot(plot, candidate.points);
		}
	}

	return { candidates, best, method, plot };
}
