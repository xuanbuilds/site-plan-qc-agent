/** Splits the footprint along the delineation lines and works out what each
 * resulting piece is.
 *
 * Ported from Part1_Identify/RegionBuilder.cs.
 *
 * This is where identification starts producing DATA rather than only labels.
 * Part 2 cannot measure a region it was never handed, and in the Rhino original
 * the faces were local variables inside the preview builder that went out of
 * scope the moment their tag text had been assembled.
 *
 * Faces are polygonized from the BRIDGED footprint, and the real paving is
 * intersected back out of each one afterwards. Doing it the other way round —
 * polygonizing the real paving directly — runs the apron cut straight through the
 * median TIP, and since a designer ends the median exactly where the apron mouth
 * begins (measured identical to four decimals on the real drive) the flare ring
 * cannot close: at -20 degrees the entire flare face vanished and went untagged,
 * while the other seven rotations happened to survive. That is the
 * noding-robustness signature, and the answer is to remove the degeneracy rather
 * than nudge the geometry. The bridged footprint has no void for a cut to pinch
 * against, so the topology is plain. */

import type { Category, ClassifiedRun } from "./classifier";
import {
	coord,
	interior_locator,
	line_string,
	snap_round_polygonize,
	type JtsCoordinate,
	type JtsPolygon,
} from "./jts";
import type { Pt, SkeletonGraph } from "./skeleton-graph";

/** Rhino.Geometry.Line, which the browser has no stand-in for. Endpoints in feet;
 * the original's z is dropped because every stage of Part 1 is planar and only
 * ever carried z through to the Grasshopper preview. */
export type Line = { from: Pt; to: Pt };

/** The one field this stage reads off an apron. apron-finder is not ported yet;
 * its full record (mouthA, mouthB, inside, outerWidth) satisfies this
 * structurally, so nothing here has to change when it lands. */
export type ApronInside = { inside: Pt };

/** One identified region of the footprint: what it is, and the paving it occupies.
 * This is Part 1's real output — the tags drawn on screen are a rendering of it,
 * and Part 2 measures it. */
export type IdentifiedRegion = {
	category: Category;
	/** The region on the BRIDGED footprint — the shape as analysed, with any
	 * median filled in. */
	face: JtsPolygon;
	/** The REAL paving inside that face, which is what may be measured: normally
	 * one, and two when a median divides a drive. */
	lanes: JtsPolygon[];
	/** The skeleton run that owns the face and carries its width profile. Null for
	 * an apron, which is recognised from the boundary arcs rather than from a run. */
	run: ClassifiedRun | null;
};

/** Snapping grid for the noding: 1e4 -> 0.0001ft cells. Coarse enough to swallow
 * floating-point noise at real site coordinates, fine enough to be far below any
 * real feature. Results are identical anywhere in the 1e2..1e6 range, so this is
 * not calibrated to a shape. */
export const SNAP_GRID_SCALE = 1e4;

export function build_regions(
	graph: SkeletonGraph,
	analysis: JtsPolygon,
	paving: JtsPolygon,
	runs: readonly ClassifiedRun[],
	aprons: readonly ApronInside[],
	stalls: readonly ApronInside[],
	delineationLines: readonly Line[]
): IdentifiedRegion[]
{
	// A cut whose two ends coincide carries no information, and it is not merely
	// useless: pre-rounding collapses it to an empty LineString and the noder then
	// walks off the end of its coordinate array, taking the whole analysis down
	// with a TypeError from inside jsts. Cheaper never to hand it one. The C# has
	// no equivalent filter because a Rhino Line survives noding either way.
	const cuts = delineationLines.filter(
		(line) => line.from.x !== line.to.x || line.from.y !== line.to.y
	);

	const inputs = [
		analysis.getBoundary(),
		...cuts.map((line) => line_string(line.from, line.to)),
	];
	const faces = snap_round_polygonize(inputs, SNAP_GRID_SCALE);

	const regions: IdentifiedRegion[] = [];
	for (const face of faces)
	{
		// Which run midpoint lands in this face. NOTE: only well-defined while each
		// face holds one run — if a cut is missing, a face holds several and this
		// picks by list order. Tried breaking that tie by node count and it made
		// things worse (a staple crossbar+leg face went Lot -> Drive, because a long
		// thin leg carries more nodes than the wider crossbar), so it is deliberately
		// left alone.
		//
		// Built once per face and reused for all three tests below: the locator
		// indexes the face's edges on construction, and the fallback pass alone can
		// ask it a few thousand questions.
		const isInside = interior_locator(face);

		let category: Category;
		let owningRun: ClassifiedRun | null = null;

		// An apron is recognised by geometry, not by a run label, so it is checked
		// first: the run whose spine passes through an apron belongs to the drive,
		// and would otherwise label it DRIVE.
		if (aprons.some((apron) => isInside(coord(apron.inside.x, apron.inside.y))))
		{
			category = "APRON";
		}
		// Same reasoning as the apron: a stall is recognised from the pavement shape,
		// not from a run label, and the run whose spine clips it belongs to the drive.
		else if (stalls.some((stall) => isInside(coord(stall.inside.x, stall.inside.y))))
		{
			category = "STALL";
		}
		else
		{
			owningRun = runs.find((run) => isInside(midNode(graph, run))) ?? null;

			// Fallback: the run holding the most of this face. Needed once apron cuts
			// exist, because they come from the boundary fillets rather than from a run
			// boundary, so an apron cut slices a drive run in two — the run midpoint
			// lands in only one half and the other used to be dropped untagged
			// (measured: a flared drive reported APRON alone, losing its DRIVE
			// entirely). Kept strictly as a fallback: making it the PRIMARY rule
			// regressed the staple, since a long thin leg outnumbers a wider crossbar
			// on node count.
			if (owningRun === null)
			{
				const ranked = runs
					.map((run) => ({
						run,
						inside: run.node_indices.filter((n) =>
							isInside(coord(graph.nodes[n].x, graph.nodes[n].y))
						).length,
					}))
					.filter((entry) => entry.inside > 0)
					// Descending by count, and ties MUST fall back to run order — LINQ's
					// OrderByDescending is a stable sort and the original leans on that.
					// Array.prototype.sort has been stable by spec since ES2019, so a
					// plain comparator matches; do not "improve" this into a tie-break.
					.sort((a, b) => b.inside - a.inside);

				owningRun = ranked.length > 0 ? ranked[0].run : null;
			}
			if (owningRun === null) continue; // a face no run reaches at all
			category = owningRun.category;
		}

		// Back to real paving. Intersecting with the actual surface, rather than
		// subtracting the median polygon, because the bridge and the median are not
		// bit-identical complements of each other: subtracting left a hair-thin
		// isthmus at some rotations and the two lanes came back as one piece. The
		// intersection asks the question that actually matters — which part of this
		// face is driveable — and cannot leave one.
		const surface = face.intersection(paving);

		const lanes: JtsPolygon[] = [];
		for (let i = 0; i < surface.getNumGeometries(); i++)
		{
			const lane = surface.getGeometryN(i);
			// An intersection that misses entirely still reports ONE geometry — an
			// empty Polygon, not an empty collection — so it is the emptiness and area
			// guards, not the loop bound, that reject a face sitting wholly on median.
			if (lane.getGeometryType() !== "Polygon") continue;
			if (lane.isEmpty() || lane.getArea() <= 0) continue;
			lanes.push(lane as JtsPolygon);
		}
		if (lanes.length === 0) continue;

		regions.push({ category, face, lanes, run: owningRun });
	}
	return regions;
}

/** The node halfway along a run — the point the containment test is asked about.
 * The C# indexes with integer division, so an even-length run takes the node just
 * past the middle rather than interpolating; reproduced exactly, because which
 * node this is decides which face claims the run. */
function midNode(graph: SkeletonGraph, run: ClassifiedRun): JtsCoordinate
{
	const node = graph.nodes[run.node_indices[Math.floor(run.node_indices.length / 2)]];
	return coord(node.x, node.y);
}


