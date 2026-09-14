/** Part 1 — feature identification, ported from the Rhino pipeline.
 *
 * Orders the stages the way IdentifyRun.cs does:
 *   median find -> bridge -> skeleton -> widths -> prune -> segment -> classify
 *
 * Bridging before the skeleton is not optional. On raw paving a divided drive
 * reads as two separate drives, and the apron mouth crosses the grass. */

import { classify_runs, type ClassifiedRun } from "./classifier";
import { find_aprons, type ApronResult } from "./apron-finder";
import { build_regions, type IdentifiedRegion, type Line } from "./region-builder";
import { apply_apron_mouths, build_delineation_lines } from "./delineation";
import { coord, interior_locator } from "./jts";
import { find_stalls, type StallFinding } from "./stall-finder";
import type { Measurement } from "../check/evaluate";
import { polygon_from_ring } from "./jts";
import { bridge, find_medians } from "./median-finder";
import { collapse_degenerate_junctions, constant_width_runs } from "./run-segmenter";
import { compute_widths, extract_skeleton } from "./skeleton-extractor";
import { oriented_box } from "./oriented-box";
import { prune } from "./skeleton-pruning";
import { distance, type Pt, type SkeletonGraph } from "./skeleton-graph";
import type { WidthProfile } from "./width-profile";

export type { Category, ClassifiedRun } from "./classifier";
export type { ApronResult, ApronFinding, BoundaryArc } from "./apron-finder";
export type { IdentifiedRegion, Line } from "./region-builder";
export type { Pt } from "./skeleton-graph";

/** Boundary sampling interval, feet. Sets skeleton node density, which both the
 * average width and the run length depend on — changing it invalidates the 2.5
 * aspect-ratio cutoff. */
const SAMPLE_SPACING_FT = 2.0;
/** A run splits when width departs from its start by more than this, feet. */
const RUN_TOLERANCE_FT = 3.0;

export type RegionLabel = {
	category: string;
	/** Inside the region, in feet. An interior point, not a centroid - a centroid
	 * can land outside an L-shaped face. */
	at: Pt;
	area_sq_ft: number;
	detail: string;
	/** Shape could not settle whether this is a parking lot or manoeuvring space
	 * belonging to the drive. The callout asks instead of asserting. */
	ambiguous: boolean;
};

export type IdentifyResult = {
	graph: SkeletonGraph;
	profile: WidthProfile;
	runs: ClassifiedRun[];
	/** Median polygons found and bridged, as rings in feet. */
	medians: Pt[][];
	counts: Record<string, number>;
	spurs_removed: number;
	/** Degenerate degree-4 medial vertices welded back from the two degree-3 nodes
	 * the Voronoi construction tore them into. One per pair of bays facing each
	 * other across a drive. */
	junctions_collapsed: number;
	/** Apron detection: two independent methods, with an explicit verdict when
	 * neither could run. Never a silently empty list. */
	aprons: ApronResult;
	/** The footprint cut into labelled faces - what the viewer draws. */
	regions: IdentifiedRegion[];
	/** The cuts those faces were split along, for drawing the dashed boundaries. */
	delineation: Line[];
	/** One label per region, anchored at a point guaranteed to be inside it. */
	labels: RegionLabel[];
	/** Single parking stalls cut into the side of the drive. */
	stalls: StallFinding[];
	/** Every measured quantity, in the form the rulebook evaluator consumes. */
	measurements: Measurement[];
	elapsed_ms: number;
};

/** `ring` must already be in FEET. Every constant above and in the ported stages
 * is absolute — running this in SVG user units silently invalidates all of them
 * and produces plausible, wrong answers. */
export type IdentifyOptions = {
	/** Enclosed gaps in the paving, as rings in FEET - a courtyard a drive loops
	 * around. Distinct from a median, which median-finder discovers on its own:
	 * these are known absences the caller already has. */
	holes?: readonly (readonly Pt[])[];
	/** Plot/property boundary as a closed ring in FEET, for the apron trim test. */
	plot?: readonly Pt[] | null;
	/** Cut lines that split the footprint into faces. Empty means one face. */
	delineation?: readonly Line[];
	/** Off disables median detection entirely, for isolating its effect. */
	bridge_medians?: boolean;
	now?: () => number;
};

export function identify(ring: readonly Pt[], options: IdentifyOptions = {}): IdentifyResult
{
	const now = options.now ?? (() => 0);
	const started = now();
	const paving = polygon_from_ring(ring, options.holes ?? []);

	const median_polygons = options.bridge_medians === false ? [] : find_medians(paving);
	const analysis = bridge(paving, median_polygons);

	const raw = extract_skeleton(analysis, SAMPLE_SPACING_FT);
	const raw_widths = compute_widths(analysis, raw);
	const pruned = prune(raw, raw_widths);
	// Between pruning and segmenting, not inside either: a torn degree-4 vertex is
	// a defect in the graph's topology, and every stage after this reasons about
	// connectivity. Same resolution the skeleton was sampled at - the graph cannot
	// mean anything finer than that.
	const welded = collapse_degenerate_junctions(pruned.graph, pruned.profile, SAMPLE_SPACING_FT);
	const runs = constant_width_runs(welded.graph, welded.profile, RUN_TOLERANCE_FT);
	const classified = classify_runs(welded.graph, welded.profile, runs);

	// Aprons run against the ANALYSIS polygon, same as the skeleton: the mouth of a
	// flare on a divided drive crosses the median, and on raw paving the covers()
	// test rejects it outright with no error.
	const aprons = find_aprons(analysis, welded.graph, welded.profile, {
		plot: options.plot ?? null,
	});

	// Stalls are pockets in the real paving, so they are found on it rather than on
	// the bridged analysis shape. The corridor width comes from the longest run,
	// which is the drive itself - its MEDIAN width, not its average. The profile
	// dips wherever the spine crosses a pinch (8.9 ft at one point on option_1,
	// against a 24 ft drive), and an average dragged down by a pinch sets the
	// opening too small to clear the bays beside the stalls.
	const spine = [...classified].sort((a, b) => b.length - a.length)[0];
	const corridor = spine ? median(spine.node_indices.map((i) => welded.profile.at(i))) : 0;
	const stalls = spine ? find_stalls(paving, corridor) : [];

	// Cuts come from the analysis polygon, the same shape the skeleton describes.
	const boundary = analysis.getExteriorRing().getCoordinates().map((c) => ({ x: c.x, y: c.y }));
	const derived = build_delineation_lines(welded.graph, welded.profile, boundary, classified);
	const delineation = apply_apron_mouths(
		[...derived, ...stalls.map((stall) => stall.mouth), ...(options.delineation ?? [])],
		aprons.aprons.map((a) => ({ from: a.mouthA, to: a.mouthB }))
	);

	const regions = build_regions(
		welded.graph,
		analysis,
		paving,
		classified,
		// An apron whose interior probe could not be placed cannot own a face, so it
		// is dropped here rather than handed on as a null the face loop would trip on.
		aprons.aprons.flatMap((a) => (a.inside ? [{ inside: a.inside }] : [])),
		stalls.map((stall) => ({ inside: stall.inside })),
		delineation
	);

	// A drive is measured from its skeleton; a stall and an apron are measured from
	// their own outline. They are different kinds of thing and the same measurement
	// does not fit both.
	//
	// For a DRIVE the skeleton is right and the face is wrong. Face ownership
	// resolves ties by run order — deliberate and regression-tested — so the owning
	// run can be a 9 ft stub inside a 9,200 sq ft drive: right category, misleading
	// dimensions. 2*area/perimeter on the face is no better, because every bay mouth
	// inflates the perimeter: it reported L465/W19.8 where the skeleton measures
	// L324/W23. The longest contained run is the spine, which is what a width check
	// is about.
	//
	// For a STALL the skeleton is wrong in a way that is not subtle. A run counts as
	// contained if ANY of its nodes falls inside the face, and the drive's spine
	// passes within a foot of a stall mouth — so a 162 sq ft pocket was reporting the
	// drive's own "width 23.1 ft / length 324.3 ft". A stall has no meaningful
	// skeleton anyway: it is a rectangle, and the code measures it as one.
	const measured: Measurement[] = regions.flatMap((region, index) =>
	{
		const is_inside = interior_locator(region.face);
		const emit = (dimension: string, value_ft: number): Measurement =>
			({ region_index: index, category: region.category, dimension, value_ft });

		if (region.category === "STALL")
		{
			const stall = stalls.find((s) => is_inside(coord(s.inside.x, s.inside.y)));
			const box = stall ? oriented_box(stall.ring) : null;
			if (!stall || !box) return [];
			// Depth is the long side. Width is area over depth, NOT the short side:
			// both stalls here measure 162.0 sq ft and 18.0 ft deep, but their boxes
			// are 9.5 and 13.5 ft across because the pocket flares where it meets the
			// drive. Dividing recovers 9.00 ft for both, which is the drawn stall.
			return [
				emit("stall_depth", box.long_ft),
				emit("stall_width", stall.area_sq_ft / box.long_ft),
			];
		}

		if (region.category === "APRON")
		{
			const apron = aprons.aprons.find(
				(a) => a.inside && is_inside(coord(a.inside.x, a.inside.y))
			);
			// The two dimensions Section 7 actually regulates: the throat is the mouth
			// where the apron leaves the drive, and the curb radii are the returns that
			// fan it out to the street. Each fillet is its own measurement — Table 7-1
			// governs them individually, and an inbound and outbound return may differ.
			//
			// Both need the fillets. Without them the apron came from the plot-line trim
			// alone, whose mouth is the cut across the property line — one step further
			// out than the throat Table 7-2 measures, and no curb returns were fit at
			// all. Nothing is emitted rather than something close.
			if (!apron?.fillets) return [];
			return [
				emit("throat_width", distance(apron.mouthA, apron.mouthB)),
				...apron.fillets.map((fillet) => emit("curb_radius", fillet.radius)),
			];
		}

		const spine = classified
			.filter((run) =>
				run.node_indices.some((i) =>
					is_inside(coord(welded.graph.nodes[i].x, welded.graph.nodes[i].y))
				)
			)
			.sort((a, b) => b.length - a.length)[0];
		if (!spine) return [];
		const key = region.category.toLowerCase();
		// The reported width is the spine's MEDIAN width. Its average is pulled down
		// by every pinch the spine crosses: option_1's drive is drawn 24.0 ft wide and
		// the average read 23.1, because the profile dips to 8.9 ft at one point. A
		// 25 ft two-way aisle drawn at exactly 25.0 would have false-failed. The
		// median reads 23.97. The classifier still uses the average for its aspect
		// ratio, where the 2.5 cutoff was tuned against it.
		const width = median(spine.node_indices.map((i) => welded.profile.at(i)));
		return [emit(key + "_width", width), emit(key + "_length", spine.length)];
	});

	const counts: Record<string, number> = {};
	for (const run of classified) counts[run.category] = (counts[run.category] ?? 0) + 1;

	return {
		graph: welded.graph,
		profile: welded.profile,
		runs: classified,
		medians: median_polygons.map((m) =>
			m.getExteriorRing().getCoordinates().map((c) => ({ x: c.x, y: c.y }))
		),
		counts,
		spurs_removed: pruned.spurs_removed,
		junctions_collapsed: welded.junctions_collapsed,
		aprons,
		regions,
		delineation,
		stalls,
		measurements: measured,
		labels: regions.map((region, index) => ({
			category: region.category,
			ambiguous: region.run?.ambiguous ?? false,
			at: region_anchor(region),
			area_sq_ft: region.lanes.reduce((total, lane) => total + lane.getArea(), 0),
			detail: measured
				.filter((m) => m.region_index === index)
				.map((m) => `${m.dimension.split("_")[1]} ${m.value_ft.toFixed(1)} ft`)
				.join(" / "),
		})),
		elapsed_ms: now() - started,
	};
}

function median(values: readonly number[]): number
{
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** A point guaranteed to lie inside a region — an interior point, not a centroid,
 * which can land outside an L-shaped face. */
function region_anchor(region: IdentifiedRegion): Pt
{
	const point = region.face.getInteriorPoint();
	return { x: point.getX(), y: point.getY() };
}

/** Area centroid of a run's node path, for anchoring its label. */
export function run_centroid(graph: SkeletonGraph, run: ClassifiedRun): Pt
{
	const points = run.node_indices.map((i) => graph.nodes[i]);
	const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
	return { x: sum.x / points.length, y: sum.y / points.length };
}
