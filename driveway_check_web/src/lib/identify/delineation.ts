/** Where one region stops and the next begins — the cuts that split the footprint.
 *
 * Ported from Part1_Identify/SkeletonPreview.cs (BuildDelineationLines and its
 * helpers). RegionBuilder does the splitting; this decides where.
 *
 * The cut comes from the footprint's OWN edges, using the skeleton only to know
 * which way the drive runs. A drive is a strip: its two side walls are the
 * boundary edges parallel to its axis, nearest the spine on either side. Each
 * wall's far end — its last point before the footprint opens out — is where the
 * drive stops being a drive, and that holds whether the junction is a sharp
 * corner (the corner vertex) or filleted (the arc's tangent point, which IS the
 * straight wall's endpoint, so no arc-specific handling is needed). Cut at
 * whichever wall ends first, perpendicular, across to the opposite wall.
 *
 * Nothing here searches outward by distance or compares widths against a
 * tolerance, which is what broke earlier attempts: sizing from the skeleton's
 * local width produced diagonal cuts through the flare, and searching outward
 * from the spine could reach clean past a real gap onto an unrelated wall. */

import type { ClassifiedRun } from "./classifier";
import type { SkeletonGraph, Pt } from "./skeleton-graph";
import type { WidthProfile } from "./width-profile";
import type { Line } from "./region-builder";

/** Facet-noise allowance, as cos(2 degrees) — not a tuned threshold. Curves are
 * faceted at 1 degree, so the first facet past a fillet's tangent point also
 * reads as near-parallel. It loses to the true straight wall anyway, since an arc
 * curves away from the spine and never toward it. */
const PARALLEL_COS = 0.99939;

/** Two cuts closer than this describe the same transition. Adding a second,
 * near-identical copy is not harmless: coincident cuts cancel during noding and
 * the footprint stops splitting there at all — measured as one face for the whole
 * shape, so everything came back APRON. */
const SAME_CUT_TOLERANCE = 0.05;

type Wall = { a: Pt; b: Pt };

const sq_distance = (p: Pt, q: Pt) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;

/** Every boundary cut between two differently-classified runs. */
export function build_delineation_lines(
	graph: SkeletonGraph,
	profile: WidthProfile,
	boundary: readonly Pt[],
	runs: readonly ClassifiedRun[]
): Line[]
{
	const lines: Line[] = [];
	const seen_nodes = new Set<number>();
	const longest_drive = [...runs]
		.filter((r) => r.category === "DRIVE")
		.sort((a, b) => b.length - a.length)[0];

	for (let i = 0; i < runs.length; i++)
	{
		for (let j = i + 1; j < runs.length; j++)
		{
			if (runs[i].category === runs[j].category) continue;

			const drive_run = runs[i].category === "DRIVE" ? runs[i] : runs[j];
			const other_run = runs[i].category === "DRIVE" ? runs[j] : runs[i];

			const junction = junction_node(graph, drive_run.node_indices, other_run.node_indices);
			if (junction === null || seen_nodes.has(junction)) continue;
			seen_nodes.add(junction);

			const line = delineation_line_at(graph, profile, boundary, drive_run.node_indices, junction);
			if (line) { lines.push(line); continue; }

			// The wall method found nothing. That happens wherever the footprint
			// widens gradually instead of turning a corner: the walls of a splaying
			// corridor sit a few degrees off the spine that bisects them, and the
			// parallel test is cos(2 degrees). On 23a219ff_option_5, 173 of the 227
			// boundary edges beside the drive lie in a 3-7 degree band and only 2 are
			// within 2, so no wall is ever found and the lot and the drive stay one
			// region.
			//
			// Cut at the point where the drive REACHES ITS CONSTANT WIDTH instead -
			// the end of the longest drive run, taken at whichever end faces this
			// junction. That is the segmenter's own answer to where the corridor
			// stops changing, so it needs no threshold, and the taper above it
			// belongs to the region it funnels into. Where there is no taper the
			// longest run already ends at the junction and this is the same point.
			const cut_at = constant_width_end(graph, longest_drive, junction);
			if (cut_at === null) continue;
			const fallback = perpendicular_cut(graph, boundary, cut_at);
			if (fallback) lines.push(fallback);
		}
	}
	return lines;
}

/** The end of the drive's constant-width run that faces this junction. */
function constant_width_end(
	graph: SkeletonGraph,
	drive: ClassifiedRun | undefined,
	junction_index: number
): number | null
{
	if (!drive || drive.node_indices.length < 2) return null;
	const junction = graph.nodes[junction_index];
	const first = drive.node_indices[0];
	const last = drive.node_indices[drive.node_indices.length - 1];
	return sq_distance(graph.nodes[first], junction) <= sq_distance(graph.nodes[last], junction)
		? first
		: last;
}

/** A cut square across the corridor at one skeleton node.
 *
 * The direction comes from the spine either side of the node rather than from a
 * single edge: consecutive nodes zigzag by hundredths of a foot, which is enough
 * to tilt a cut noticeably out of square, and averaging over a short span damps
 * that without smoothing away a real bend. Both rays are then cast until they
 * leave the footprint, so the cut spans the paving whatever shape its walls are. */
function perpendicular_cut(
	graph: SkeletonGraph,
	boundary: readonly Pt[],
	node_index: number
): Line | null
{
	const at = graph.nodes[node_index];
	const neighbours = graph.edges
		.filter(([a, b]) => a === node_index || b === node_index)
		.map(([a, b]) => graph.nodes[a === node_index ? b : a]);
	if (neighbours.length === 0) return null;

	// Average the directions to the node's neighbours. On a through-node the two
	// nearly cancel, so fall back to the single longest leg.
	let dx = 0;
	let dy = 0;
	for (const p of neighbours)
	{
		const d = Math.hypot(p.x - at.x, p.y - at.y);
		if (d < 1e-9) continue;
		dx += (p.x - at.x) / d;
		dy += (p.y - at.y) / d;
	}
	if (Math.hypot(dx, dy) < 0.2)
	{
		const far = neighbours.reduce((best, p) =>
			sq_distance(p, at) > sq_distance(best, at) ? p : best
		);
		dx = far.x - at.x;
		dy = far.y - at.y;
	}
	const length = Math.hypot(dx, dy);
	if (length < 1e-9) return null;

	const cut_x = -dy / length;
	const cut_y = dx / length;
	const hit_pos = ray_to_boundary(boundary, at, cut_x, cut_y);
	const hit_neg = ray_to_boundary(boundary, at, -cut_x, -cut_y);
	if (!hit_pos || !hit_neg) return null;
	return { from: hit_pos, to: hit_neg };
}

/** Nearest boundary crossing along a ray from a point inside the footprint. */
function ray_to_boundary(
	boundary: readonly Pt[],
	origin: Pt,
	dir_x: number,
	dir_y: number
): Pt | null
{
	let best: Pt | null = null;
	let best_t = Number.MAX_VALUE;
	for (let i = 0; i + 1 < boundary.length; i++)
	{
		const a = boundary[i];
		const b = boundary[i + 1];
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const denom = dir_x * ey - dir_y * ex;
		if (Math.abs(denom) < 1e-12) continue;
		const ox = a.x - origin.x;
		const oy = a.y - origin.y;
		const t = (ox * ey - oy * ex) / denom;
		const u = (ox * dir_y - oy * dir_x) / denom;
		if (t <= 1e-9 || u < 0 || u > 1) continue;
		if (t < best_t) { best_t = t; best = { x: origin.x + dir_x * t, y: origin.y + dir_y * t }; }
	}
	return best;
}

function delineation_line_at(
	graph: SkeletonGraph,
	profile: WidthProfile,
	boundary: readonly Pt[],
	drive_node_indices: readonly number[],
	junction_index: number
): Line | null
{
	const junction = graph.nodes[junction_index];

	// Whichever of the drive run's two ends lies farther from the junction. The
	// junction is not guaranteed to BE one of them (see junction_node), so an
	// index comparison will not do.
	const first = drive_node_indices[0];
	const last = drive_node_indices[drive_node_indices.length - 1];
	const far_index =
		sq_distance(graph.nodes[first], junction) >= sq_distance(graph.nodes[last], junction)
			? first
			: last;
	const far = graph.nodes[far_index];

	const dx = junction.x - far.x;
	const dy = junction.y - far.y;
	const axis_length = Math.hypot(dx, dy);
	if (axis_length < 1e-9) return null; // junction and far end coincide: no axis
	const dir_x = dx / axis_length;
	const dir_y = dy / axis_length;
	const perp_x = -dir_y;
	const perp_y = dir_x;

	// Signed perpendicular offset and along-axis position, both from the junction.
	const offset = (p: Pt) => (p.x - junction.x) * perp_x + (p.y - junction.y) * perp_y;
	const along = (p: Pt) => (p.x - junction.x) * dir_x + (p.y - junction.y) * dir_y;

	// Only walls that REACH this junction are candidates, and one local width is
	// the natural span: the drive's own side walls either cross the junction or
	// stop just short, while anything a whole width further along belongs to some
	// other part of the drive.
	//
	// Ranking on perpendicular offset alone is not enough. A faceted flare 120 ft
	// away at the apron throws off dozens of near-parallel 0.11 ft edges, and one
	// sat 8.89 ft from the spine against the real wall's 9.82 ft. It won, the cut
	// was built at the apron instead of the junction, and was then discarded for
	// crossing the apron mouth — so a drive running into a parking block produced
	// no cut at all and the LOT was lost entirely.
	const reach = profile.at(junction_index);
	const wall_pos = nearest_parallel_wall(boundary, dir_x, dir_y, offset, along, reach, true);
	const wall_neg = nearest_parallel_wall(boundary, dir_x, dir_y, offset, along, reach, false);
	if (!wall_pos || !wall_neg) return null;

	const end_pos = wall_end_toward_junction(wall_pos, along);
	const end_neg = wall_end_toward_junction(wall_neg, along);

	// Whichever wall ends first — further back from the junction — sets the cut's
	// cross-section. Past that point the footprint has already opened out on at
	// least one side.
	const pos_ends_first = along(end_pos) <= along(end_neg);
	const anchor = pos_ends_first ? end_pos : end_neg;
	const anchor_wall = pos_ends_first ? wall_pos : wall_neg;
	const opposite_wall = pos_ends_first ? wall_neg : wall_pos;

	// Square the cut to the anchor wall itself, not to the skeleton axis used to
	// find the walls: the skeleton's nodes zigzag by hundredths of a foot, which is
	// invisible in a direction test but enough to tilt a 12 ft cut out of square.
	const wx = anchor_wall.b.x - anchor_wall.a.x;
	const wy = anchor_wall.b.y - anchor_wall.a.y;
	const wall_length = Math.hypot(wx, wy);
	if (wall_length < 1e-9) return null;
	const cut_x = -wy / wall_length;
	const cut_y = wx / wall_length;

	const hit = intersect_with_wall(anchor, cut_x, cut_y, opposite_wall);
	if (!hit) return null;

	return { from: anchor, to: hit };
}

/** The boundary edge parallel to the drive's axis sitting closest to the spine on
 * the requested side — one of the drive's own two side walls. */
function nearest_parallel_wall(
	boundary: readonly Pt[],
	dir_x: number,
	dir_y: number,
	offset: (p: Pt) => number,
	along: (p: Pt) => number,
	reach: number,
	positive_side: boolean
): Wall | null
{
	let best: Wall | null = null;
	let best_offset = Number.MAX_VALUE;

	for (let i = 0; i + 1 < boundary.length; i++)
	{
		const a = boundary[i];
		const b = boundary[i + 1];
		const ex = b.x - a.x;
		const ey = b.y - a.y;
		const edge_length = Math.hypot(ex, ey);
		if (edge_length < 1e-9) continue;
		if (Math.abs((ex * dir_x + ey * dir_y) / edge_length) < PARALLEL_COS) continue;

		// How far this edge stops short of the junction along the drive — zero when
		// it spans the junction outright.
		const along_a = along(a);
		const along_b = along(b);
		const spans_junction = (along_a <= 0 && along_b >= 0) || (along_b <= 0 && along_a >= 0);
		const along_gap = spans_junction ? 0 : Math.min(Math.abs(along_a), Math.abs(along_b));
		if (along_gap > reach) continue;

		const mid_offset = (offset(a) + offset(b)) / 2;
		if (positive_side ? mid_offset <= 0 : mid_offset >= 0) continue;

		const d = Math.abs(mid_offset);
		if (d < best_offset)
		{
			best_offset = d;
			best = { a, b };
		}
	}
	return best;
}

function wall_end_toward_junction(wall: Wall, along: (p: Pt) => number): Pt
{
	return along(wall.a) >= along(wall.b) ? wall.a : wall.b;
}

/** Where the cut meets the opposite wall's own line, extended if the walls end at
 * different points along the axis — which is exactly the asymmetric case this
 * exists to handle. */
function intersect_with_wall(origin: Pt, dir_x: number, dir_y: number, wall: Wall): Pt | null
{
	const ex = wall.b.x - wall.a.x;
	const ey = wall.b.y - wall.a.y;
	const denominator = dir_x * ey - dir_y * ex;
	// The cut running along the wall cannot happen for a real side wall.
	if (Math.abs(denominator) < 1e-12) return null;
	const t = ((wall.a.x - origin.x) * ey - (wall.a.y - origin.y) * ex) / denominator;
	return { x: origin.x + t * dir_x, y: origin.y + t * dir_y };
}

/** Where two runs actually meet.
 *
 * Segmentation does NOT guarantee that adjacent runs share one of their four end
 * nodes: they can overlap on interior nodes, or meet across a graph edge without
 * sharing an index at all. Measured on a pad-on-drive footprint whose Drive run
 * ended (9,90) while its Lot run ended (0,101) — no shared end, so no cut was
 * produced, the whole footprint stayed one face, and a correctly classified Lot
 * was reported as Drive. Shared-end is still checked first because it is the
 * common case and pins the junction exactly. */
function junction_node(
	graph: SkeletonGraph,
	drive_run: readonly number[],
	other_run: readonly number[]
): number | null
{
	const drive_ends = [drive_run[0], drive_run[drive_run.length - 1]];
	const other_ends = [other_run[0], other_run[other_run.length - 1]];
	for (const x of drive_ends)
	{
		for (const y of other_ends) if (x === y) return x;
	}

	const other_set = new Set(other_run);
	const overlap = drive_run.filter((i) => other_set.has(i));
	if (overlap.length > 0) return overlap[Math.floor(overlap.length / 2)];

	const drive_set = new Set(drive_run);
	for (const [a, b] of graph.edges)
	{
		if (drive_set.has(a) && other_set.has(b)) return a;
		if (drive_set.has(b) && other_set.has(a)) return b;
	}
	return null;
}

/** Either direction counts as the same cut. */
export function same_cut(a: Line, b: Line): boolean
{
	const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < SAME_CUT_TOLERANCE;
	return (
		(near(a.from, b.from) && near(a.to, b.to)) ||
		(near(a.from, b.to) && near(a.to, b.from))
	);
}

/** Whether two cuts meet anywhere along their lengths. Parallel and collinear
 * pairs report false — that is what same_cut is for; this catches the near-miss
 * that slips past it. */
export function crosses(a: Line, b: Line): boolean
{
	const ax = a.to.x - a.from.x;
	const ay = a.to.y - a.from.y;
	const bx = b.to.x - b.from.x;
	const by = b.to.y - b.from.y;
	const denominator = ax * by - ay * bx;
	if (Math.abs(denominator) < 1e-12) return false;

	const wx = b.from.x - a.from.x;
	const wy = b.from.y - a.from.y;
	const on_a = (wx * by - wy * bx) / denominator;
	const on_b = (wx * ay - wy * ax) / denominator;
	return on_a >= 0 && on_a <= 1 && on_b >= 0 && on_b <= 1;
}

/** Folds each apron mouth into the cut list, displacing any run-boundary cut that
 * describes the same transition.
 *
 * The run-boundary pass finds the same throat on its own — the flare IS a width
 * transition — but it sizes the cut from the drive's own side walls, while the
 * mouth spans the fillets' tangent points. Those agree only when the two fillets
 * are symmetric. On a real flared drive they were not (r=7.27 against r=13.76):
 * the wall-anchored cut came out 18.00 ft square to the drive, the mouth 18.92 ft,
 * sharing one end and splaying 5.6 ft apart at the other — far too wide a gap for
 * same_cut, so both survived and the sliver between them became its own face with
 * a spurious DRIVE tag. Two cuts that meet inside the paving describe one
 * transition, and the mouth is the definitional one, so the derived cut gives way. */
export function apply_apron_mouths(
	lines: readonly Line[],
	mouths: readonly Line[]
): Line[]
{
	let result = [...lines];
	for (const mouth of mouths)
	{
		result = result.filter((existing) => !same_cut(existing, mouth) && !crosses(existing, mouth));
		result.push(mouth);
	}
	return result;
}
