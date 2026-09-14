/** The property boundary, read off the drawing's own dash-dot line work.
 *
 * Drafting draws a property line as long-dash / gap / short-dash / gap, which in
 * SVG is a four-value `stroke-dasharray` whose first value exceeds its third:
 * "10, 6, 3, 6". Setbacks, easements and hidden edges use one or two values -
 * "8", "2", "4" - so the four-value pattern picks out the boundary and nothing
 * else. 439 of the 450 corpus plans with a tagged drive carry it.
 *
 * The line arrives as a handful of separate open polylines, one per property
 * edge, which is why it is invisible to anything that only looks at closed
 * shapes. They are chained end to end back into a ring here.
 *
 * WHICH RING. A plan can carry several - 71 of the corpus do - because adjacent
 * parcels and flood lines are drawn the same way, and the biggest is not
 * reliably the site: on 55336cac_option_1 the three rings measure 476k, 445k and
 * 413k units and the site is the middle one. So the ring is chosen as the one
 * containing the most of a shape already known to be on the site. That makes it
 * useless for finding the drive in the first place - it needs the drive - but
 * safe for everything after, because the boundary cannot exclude the shape that
 * selected it.
 *
 * WHAT IT IS WORTH. Over the 450 plans with a tagged drive: a boundary is found
 * on 392, and filtering by it excludes 72,898 shapes of which 72,319 - 99.2% -
 * are the white context parcels drawn for the neighbouring properties. The other
 * 58 plans get no boundary and no filtering, which is the honest outcome rather
 * than a guessed one. */

import type { Pt } from "./identify/skeleton-graph";

/** Two vertices of one shape may be this far apart and still count as the same
 * point when chaining edges into a ring. Drawing units; the exporter writes its
 * coordinates to four decimals, so this is far above the noise and far below any
 * real gap between two property edges. */
const JOIN_TOLERANCE = 0.5;

const NUMBER = /-?\d+\.?\d*(?:e[+-]?\d+)?/gi;

export type PlotBoundary = {
	/** The closed ring, in SVG user units. */
	ring: [number, number][];
	/** Share of the anchor shape's vertices that fall inside it. Well under 1 is
	 * normal and correct: a driveway apron crosses the property line by design. */
	coverage: number;
	/** How many closed rings the dash-dot line work produced in total. */
	rings_found: number;
};

/** Long-dash / gap / short-dash / gap. One or two values is a plain dash.
 *
 * parseFloat, not Number: the attribute form is written bare ("10, 6, 3, 6") but
 * getComputedStyle hands back CSS pixels ("10px, 6px, 3px, 6px"), and Number()
 * makes NaN of every one of those. That silently dropped all 457 class-styled
 * plans and left only the 36 attribute-styled ones with a boundary. */
function is_dash_dot(pattern: string): boolean
{
	const values = pattern.split(/[\s,]+/).map(parseFloat).filter((n) => !Number.isNaN(n));
	return values.length === 4 && values[0] > values[2];
}

function points_of(el: Element): [number, number][] | null
{
	const tag = el.nodeName.toLowerCase();
	const raw = tag === "path" ? el.getAttribute("d") : el.getAttribute("points");
	if (!raw) return null;
	// A curved edge would need flattening before it could be chained; no corpus
	// plan draws a property line with one.
	if (tag === "path" && /[CcSsQqAa]/.test(raw)) return null;
	const nums = raw.match(NUMBER)?.map(Number);
	if (!nums || nums.length < 4) return null;
	const out: [number, number][] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
	return out;
}

function near(a: [number, number], b: [number, number]): boolean
{
	return Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOIN_TOLERANCE;
}

/** Chain open edges end to end, keeping only the chains that close. */
function rings_from(edges: [number, number][][]): [number, number][][] {
	const rings: [number, number][][] = [];
	const used = new Array(edges.length).fill(false);

	for (let i = 0; i < edges.length; i++)
	{
		if (used[i]) continue;
		used[i] = true;
		let chain = edges[i].slice();

		// Edges come in no particular order, so keep sweeping until a pass adds
		// nothing: an edge that fits may sit anywhere in the list.
		let grew = true;
		while (grew)
		{
			grew = false;
			for (let j = 0; j < edges.length; j++)
			{
				if (used[j]) continue;
				const edge = edges[j];
				const head = chain[0];
				const tail = chain[chain.length - 1];
				if (near(tail, edge[0])) chain = chain.concat(edge.slice(1));
				else if (near(tail, edge[edge.length - 1])) chain = chain.concat(edge.slice().reverse().slice(1));
				else if (near(head, edge[edge.length - 1])) chain = edge.slice(0, -1).concat(chain);
				else if (near(head, edge[0])) chain = edge.slice().reverse().slice(0, -1).concat(chain);
				else continue;
				used[j] = true;
				grew = true;
			}
		}

		if (chain.length >= 4 && near(chain[0], chain[chain.length - 1])) rings.push(chain);
	}
	return rings;
}

function contains(ring: readonly [number, number][], point: readonly [number, number]): boolean
{
	let hit = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
	{
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi)
		{
			hit = !hit;
		}
	}
	return hit;
}

function ring_area(ring: readonly [number, number][]): number
{
	let twice = 0;
	for (let i = 0; i < ring.length; i++)
	{
		const j = (i + 1) % ring.length;
		twice += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
	}
	return Math.abs(twice / 2);
}

/** `anchor` is a shape already known to be on the site - the detected paving.
 * Returns null when the drawing carries no dash-dot line work, when none of it
 * closes, or when no closed ring touches the anchor. */
export function read_plot_boundary(
	svg: Element,
	anchor: readonly [number, number][]
): PlotBoundary | null
{
	const edges: [number, number][][] = [];
	svg.querySelectorAll("path, polyline, polygon, line").forEach((el) =>
	{
		const pattern = el.getAttribute("stroke-dasharray");
		if (!pattern || !is_dash_dot(pattern)) return;
		const points = points_of(el);
		if (points) edges.push(points);
	});
	if (edges.length === 0) return null;

	const rings = rings_from(edges);
	if (rings.length === 0) return null;

	let best: PlotBoundary | null = null;
	for (const ring of rings)
	{
		const coverage = anchor.filter((p) => contains(ring, p)).length / anchor.length;
		if (coverage === 0) continue;
		// Most of the anchor wins; the tighter ring breaks a tie, since a parcel
		// nests inside any larger boundary drawn the same way.
		if (!best || coverage > best.coverage + 1e-9 ||
			(Math.abs(coverage - best.coverage) < 1e-9 && ring_area(ring) < ring_area(best.ring)))
		{
			best = { ring, coverage, rings_found: rings.length };
		}
	}
	return best;
}

/** Whether a shape is on the site: ANY vertex inside the boundary counts. The
 * apron crosses the property line into the right of way by design, so a test for
 * "wholly inside" would put the drive itself off site. */
export function overlaps_plot(boundary: PlotBoundary, ring: readonly [number, number][]): boolean
{
	return ring.some((p) => contains(boundary.ring, p));
}

export type { Pt };
