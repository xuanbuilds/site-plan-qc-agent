/** Single parking stalls cut into the side of a drive.
 *
 * Not in the Rhino original — this is new, and it is shape-only, which is what
 * makes it worth having: no layer, no label, no drawn rectangle.
 *
 * A stall taken off a drive is a dead-end pocket. Morphological OPENING (erode
 * then dilate by a radius set between a stall's width and the drive's) keeps the
 * through-route and drops every pocket, so paving minus its own opening IS the
 * set of pockets. A pocket that could hold a standard stall is one; a shallower
 * pocket is the apron in front of a garage, which belongs to the drive.
 *
 * Measured on the townhouse plan: 20 pockets. Two at **162 sq ft** — exactly
 * 9 x 18 — and eighteen at 49-90 sq ft. That is not a gradient, it is two
 * populations, and the cut between them is the code's own stall size rather than
 * a number picked to fit. */

import { boundary_distance, coord, mitre_buffer, polygon_from_ring, type JtsPolygon } from "./jts";
import { oriented_box } from "./oriented-box";
import type { Pt } from "./skeleton-graph";
import type { Line } from "./region-builder";

/** TCM Table 9-2, standard 90-degree stall: 9 ft wide, 18 ft deep. */
export const STALL_WIDTH_FT = 9;
export const STALL_DEPTH_FT = 18;
const STALL_AREA_SQ_FT = STALL_WIDTH_FT * STALL_DEPTH_FT;

/** Longest stall in TCM Table 9-2: a parallel space, 22 ft by 8 ft-6 in. Every
 * other row is shallower, so nothing the table calls a stall exceeds this. */
const MAX_STALL_LENGTH_FT = 22;

/** A pocket has to be able to HOLD a stall, not match one exactly — its mouth
 * flares where it meets the drive, so it reads slightly larger, and the erosion
 * rounds its corners, so it reads slightly smaller. A tenth either way covers
 * both. Measured margin: the stalls sit at 162 and the next pocket down at 90. */
const AREA_ALLOWANCE = 0.9;

/** How far a pocket vertex may sit from the paving boundary and still count as
 * lying on it. Buffer output carries a little numerical drift; a hundredth of a
 * foot is far below any real feature and far above that drift. */
const WALL_TOLERANCE_FT = 0.01;

export type StallFinding = {
	/** The pocket itself, as a ring in feet. */
	ring: Pt[];
	/** A point known to be inside it, for recognising the split face downstream. */
	inside: Pt;
	/** Where the pocket meets the drive — a delineation cut like any other. */
	mouth: Line;
	area_sq_ft: number;
	/** How the stall sits against the aisle, in degrees: 90 is head-in. Null when
	 * the pocket has no side wall long enough to read a direction from. */
	angle_to_aisle_deg: number | null;
};

/** Straight runs of the ring, longest first.
 *
 * A pocket's outline has far more vertices than it has sides — the paving it was
 * cut from is a tessellated SVG path — so consecutive vertices are walked and
 * only a real corner ends a run. The threshold does not need tuning: the buffer
 * uses mitre joins, so every corner in this outline is a drawn corner and turns
 * are either ~0 or tens of degrees, with nothing in between. */
const CORNER_TURN_DEG = 5;

function straight_runs(ring: readonly Pt[]): { length: number; ux: number; uy: number }[]
{
	const points = ring.slice(0, -1);
	const count = points.length;
	if (count < 3) return [];

	const direction = (a: Pt, b: Pt) =>
	{
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		return length < 1e-9 ? null : { length, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length };
	};

	const runs: { length: number; ux: number; uy: number }[] = [];
	let start = 0;
	for (let i = 0; i < count; i++)
	{
		const here = direction(points[start], points[(i + 1) % count]);
		const next = direction(points[(i + 1) % count], points[(i + 2) % count]);
		if (!here || !next) continue;
		const turn = Math.acos(Math.max(-1, Math.min(1, here.ux * next.ux + here.uy * next.uy)));
		if (turn * (180 / Math.PI) <= CORNER_TURN_DEG) continue;
		runs.push(here);
		start = (i + 1) % count;
	}
	return runs.sort((a, b) => b.length - a.length);
}

/** The angle a stall makes with the aisle it opens onto.
 *
 * Read off the pocket's own outline: its longest side wall against the closure
 * across its mouth, which lies along the drive. That is the same comparison a
 * person makes looking at the stripes against the edge of the drive.
 *
 * The alternative — comparing the stall to the nearest skeleton run — does not
 * work. For an isolated pocket the nearest run is the main drive rather than the
 * aisle the stall faces, and on this plan it read 4 and 26 degrees for two stalls
 * that both measure 89.93 this way. */
function angle_to_aisle(ring: readonly Pt[], mouth: Line): number | null
{
	const span = Math.hypot(mouth.to.x - mouth.from.x, mouth.to.y - mouth.from.y);
	if (span < 1e-9) return null;
	const mx = (mouth.to.x - mouth.from.x) / span;
	const my = (mouth.to.y - mouth.from.y) / span;

	// The mouth is itself one of the runs, so it is skipped by length. A side wall
	// shorter than the stall is narrow gives no direction worth trusting.
	const side = straight_runs(ring).find(
		(run) => Math.abs(run.length - span) > 0.05 && run.length >= STALL_WIDTH_FT
	);
	if (!side) return null;

	const cosine = Math.abs(side.ux * mx + side.uy * my);
	return Math.acos(Math.min(1, cosine)) * (180 / Math.PI);
}

function ring_of(polygon: JtsPolygon): Pt[]
{
	return polygon.getExteriorRing().getCoordinates().map((c) => ({ x: c.x, y: c.y }));
}

/** The opening removes everything narrower than twice its radius. It has to
 * remove EVERY pocket - the 9 ft stalls, but also the bays beside them, which on
 * option_1 are 21-22 ft across - while leaving the drive, and the drive is only a
 * little wider than its widest bay. Sweeping the radius on both plans:
 *
 *   option_1 (drive 24.0 ft median):  2r = 14..21  one stall malformed - a bay
 *            survives and its re-dilated outline spills into the pocket next door;
 *            2r = 22.0..23.4  both stalls clean at 162 sq ft;  2r = 25  the drive
 *            itself dies.
 *   option_4 (alley 31.0 ft):  2r <= 31.0 intact;  2r = 31.1 dies - three "stalls"
 *            260 to 706 ft deep and no DRIVE left.
 *
 * So the cut sits just below the drive's width. Five percent below is 22.8 ft on
 * option_1 and 29.5 ft on option_4, inside both windows with room either side.
 * Half the average width - the first choice - put it 0.1 ft from the edge on both
 * plans, one way on each. */
const CORRIDOR_MARGIN = 0.95;

/** `corridor_width` is the drive's typical width, its median along the spine, so
 * the opening scales with the plan instead of being a fixed distance. */
export function find_stalls(paving: JtsPolygon, corridor_width: number): StallFinding[]
{
	if (!(corridor_width > STALL_WIDTH_FT)) return [];
	const radius = (corridor_width * CORRIDOR_MARGIN) / 2;

	const opened = mitre_buffer(mitre_buffer(paving, -radius), radius);
	if (opened.isEmpty()) return [];
	const pockets = paving.difference(opened);
	const distance_to_wall = boundary_distance(paving.getExteriorRing());

	const found: StallFinding[] = [];
	for (let i = 0; i < pockets.getNumGeometries(); i++)
	{
		const pocket = pockets.getGeometryN(i);
		if (pocket.getGeometryType() !== "Polygon") continue;
		const area = pocket.getArea();
		if (area < STALL_AREA_SQ_FT * AREA_ALLOWANCE) continue;

		const ring = ring_of(pocket as JtsPolygon);
		// The smallest enclosing rectangle, not the longest chord. A chord runs
		// corner to corner, so on option_1 a real 13.5 x 18.0 ft stall measures 22.5
		// across the diagonal and a 22 ft length bound threw it away. The box sides
		// are the stall's own dimensions.
		const box = oriented_box(ring);
		if (!box) continue;
		// Wide enough to hold a stall across its narrow direction. Without this a
		// long shallow scallop of the same area would qualify.
		if (box.short_ft < STALL_WIDTH_FT) continue;
		// And no longer than the longest stall the code describes. Nothing bounded
		// the far dimension before, so on 23a219ff_option_5 a 39.5 ft sliver of the
		// drive came back as a stall and relabelled the whole 2,264 sq ft region.
		if (box.long_ft > MAX_STALL_LENGTH_FT) continue;

		// A pocket's ring is part real paving wall and part artificial closure drawn
		// across its mouth by the opening. The mouth is the closure — so it is the
		// run of ring vertices that do NOT sit on the original paving boundary.
		//
		// Intersecting the two boundaries directly does not work: buffer output is
		// only approximately coincident with its input, and measured on this plan one
		// pocket met the corridor at two isolated POINTS and the other at nothing at
		// all. The paving boundary, by contrast, is exact input geometry, so asking
		// how far each vertex sits from it is stable.
		// Tested per EDGE, at its midpoint — not per vertex. The closure is usually a
		// single segment, so BOTH its endpoints sit on the wall where it meets it, and
		// a vertex test finds nothing off-wall at all. Its midpoint spans the opening.
		let mouth: Line | null = null;
		let longest = 0;
		for (let e = 0; e + 1 < ring.length; e++)
		{
			const from = ring[e];
			const to = ring[e + 1];
			const mid = coord((from.x + to.x) / 2, (from.y + to.y) / 2);
			if (distance_to_wall(mid) <= WALL_TOLERANCE_FT) continue;
			const span = Math.hypot(to.x - from.x, to.y - from.y);
			if (span > longest) { longest = span; mouth = { from, to }; }
		}
		if (!mouth) continue;

		const point = (pocket as JtsPolygon).getInteriorPoint();
		found.push({
			ring,
			inside: { x: point.getX(), y: point.getY() },
			mouth,
			area_sq_ft: area,
			angle_to_aisle_deg: angle_to_aisle(ring, mouth),
		});
	}
	return found;
}

export { polygon_from_ring };
