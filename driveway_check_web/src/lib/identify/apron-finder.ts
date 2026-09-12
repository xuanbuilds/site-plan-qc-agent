/** Aprons: where a drive flares out through fillets on both sides and ends in a
 * segment wider than the drive itself, while not being a lot.
 *
 * Ported from Part1_Identify/Core/ApronFinder.cs, with one change the browser
 * forces, one it invites, and a result type that refuses to lie.
 *
 * FORCED — THE ARCS. The C# was handed BoundaryArcs lifted off Rhino Breps,
 * which carry true arcs with exact centres, radii and tangent points. An SVG
 * carries nothing of the kind: the test plan contains ZERO `A` path commands, so
 * every curb return arrives as a run of straight chords. PORT_PLAN §3 item 12
 * ruled circle-fitting out on that basis and told this file to report "apron
 * detection unavailable" instead. That ruling rested on an assumption about fit
 * error, and the assumption has since been measured false:
 *
 *   - the tessellation is a uniform 0.5 ft chord densification;
 *   - straight runs have a median turn angle of exactly 0.000 deg, so "is this
 *     curved" is not a judgement call — a curve is the only thing that turns;
 *   - grouping vertices whose turn angle lies in [0.05, 20) deg and fitting
 *     circles by algebraic least squares recovered both real curb returns at
 *     r = 11.00 ft, sweep 87.7 and 88.1 deg, max fit error 0.0028 ft.
 *
 * MouthTrim is 0.01 ft, so the fit error is ~4x below the smallest dimension
 * this file depends on. Refitting is viable here. The concern behind the
 * original ruling is not discarded but ENFORCED: a refit whose error is not
 * below MouthTrim is rejected outright rather than rounded off, so the failure
 * mode the plan feared ("confident wrong answers") cannot occur silently — it
 * surfaces as no-arc-data instead.
 *
 * INVITED — THE PLOT LINE. The part of the paving lying outside the plot
 * boundary is, by definition, the apron: the drive is allowed to end at the
 * property line, and what continues past it to meet the street is the flare.
 * That is a completely independent signal — it uses no arcs, no skeleton and no
 * widths — so when it agrees with the throat test the two together are worth far
 * more than either alone. It is also not reliably available: in the test plan the
 * dash-dot property line imports as two unique 2-point segments, not a closed
 * ring, so this method must degrade cleanly rather than return an empty answer.
 *
 * THE RESULT TYPE. "No arc data" and "no plot line" are DISTINCT SURFACED
 * STATES. Neither is ever an empty array. PORT_PLAN's hazard #5 is precisely
 * this: `ApronFinder.Find` returning an empty list for missing arcs, downstream
 * reading that as "this plan has no apron", and a QC tool reporting a clean bill
 * of health because it could not look. Every exit from this file says which of
 * the two tests ran, which could not, and why.
 *
 * Deliberately NOT added: a perpendicularity test on the mouth. It was measured
 * and rejected — real mouths cross the spine at 79 and 73 deg, false diagonals
 * at 79 and 76. The ranges overlap outright. */

import {
	coord,
	factory,
	is_topology_failure,
	polygon_from_ring,
	type JtsCoordinate,
	type JtsGeometry,
	type JtsPolygon,
} from "./jts";
import { distance, type Pt, type SkeletonGraph } from "./skeleton-graph";
import type { WidthProfile } from "./width-profile";

/* ------------------------------------------------------------------ arcs -- */

/** A genuine arc in the footprint's outline.
 *
 * From Core/BoundaryArc.cs. `start`/`end` are the arc's TANGENT POINTS, where it
 * meets the straight stretches either side — that is what makes them usable as
 * cut anchors, and the whole apron test is built on them. `radius` is also what a
 * turning-radius code check needs later, so it is carried even though nothing
 * here reads it.
 *
 * `fitErrorFt` and `vertexCount` are additions: a refit arc is evidence, not a
 * fact, and the evidence travels with it so a caller can show its quality rather
 * than trust it blindly. A `path-arc` (from a real SVG `A` command) has zero fit
 * error by construction. */
export type BoundaryArc = {
	start: Pt;
	end: Pt;
	center: Pt;
	radius: number;
	/** Always positive, degrees. */
	sweepDeg: number;
	/** Largest distance from a source vertex to the fitted circle, feet. */
	fitErrorFt: number;
	/** Ring vertices the fit consumed. 0 for a path-arc. */
	vertexCount: number;
	source: "path-arc" | "refit";
};

/** Straight-line distance across the arc, tangent point to tangent point — the
 * width the flare actually opens up by on this side. */
export function chord_length(arc: BoundaryArc): number
{
	return distance(arc.start, arc.end);
}

export type RefitRejection = {
	vertexCount: number;
	reason: string;
};

export type ArcRefit = {
	arcs: BoundaryArc[];
	/** Runs that turned but failed a gate. Surfaced so "no arcs" can be explained
	 * as "nothing curved" or as "curves too rough to trust", which are different
	 * problems with different fixes. */
	rejected: RefitRejection[];
	/** Ring vertices scanned, for the same reason. */
	vertexCount: number;
};

/** Below this a vertex is straight. The measured median turn on straight runs is
 * exactly 0.000 deg, so this is not a tuned tolerance — it is a floor over
 * nothing, sized to swallow float noise in the exporter's coordinates. */
const TURN_FLOOR_DEG = 0.05;
/** At or above this a vertex is a corner, not a tessellated curve.
 *
 * With a uniform 0.5 ft chord the per-vertex turn is ~2*asin(0.25/r), so this
 * window is really a RADIUS window: [0.05, 20) deg admits radii from about 1.4 ft
 * to about 573 ft. Both ends are far outside anything a curb return can be, which
 * is why the window separates cleanly rather than needing to be tuned. The two
 * real returns sit at 2.6 deg per vertex. */
const TURN_CEILING_DEG = 20;
/** Minimum vertices in a run before a circle is fitted at all.
 *
 * Three points define a circle exactly, so a short chain of float noise fits
 * perfectly and reports a confident garbage radius. Requiring 8 makes the fit
 * over-determined by 5 and gives the error gate below something to measure. The
 * real returns supply ~35 vertices each. */
const MIN_RUN_VERTICES = 8;

/** Trim taken off each end of the mouth before testing it against the paving.
 *
 * From the C#: the tangent points sit exactly ON the boundary by construction,
 * "exactly" holds only to a few bits at float precision, and testing the
 * full-length segment made aprons vanish on rotated footprints while their
 * unrotated twins were found. Pulling both ends a hair inward turns a fragile
 * boundary-touch into an unambiguous interior test.
 *
 * It doubles here as the acceptance gate on a refit arc. That is deliberate and
 * it is the load-bearing safety property of this file: a fitted arc is trusted
 * only when its worst vertex lies closer to the fitted circle than the smallest
 * distance any downstream test can resolve. Measured error 0.0028 ft passes with
 * 4x to spare; anything that does not pass is reported as no-arc-data, never
 * silently used. */
const MOUTH_TRIM = 0.01;

/** jts.ts hand-writes the jsts surface it uses, and `createLineString` is the one
 * member this file needs that is not on it yet. Narrowed here rather than
 * loosened there, so jts.ts stays the only module that imports jsts. Promote it
 * onto the shared typing if a third caller appears. */
const lineFactory = factory as unknown as {
	createLineString(coords: JtsCoordinate[]): JtsGeometry;
};

/** Ring coordinates as plain points, with jsts's repeated closing vertex dropped
 * — left in, it reads as a zero-length segment and its turn angle is undefined. */
function ringPoints(ring: JtsGeometry): Pt[]
{
	const points = ring.getCoordinates().map((c) => ({ x: c.x, y: c.y }));
	const first = points[0];
	const last = points[points.length - 1];
	if (points.length > 1 && first.x === last.x && first.y === last.y) points.pop();
	return points;
}

/** Signed turn at `curr`, degrees. Sign carries the direction of the bend, which
 * is what keeps an S-curve from chaining into one bogus arc. */
function turnDegrees(prev: Pt, curr: Pt, next: Pt): number
{
	const ax = curr.x - prev.x;
	const ay = curr.y - prev.y;
	const bx = next.x - curr.x;
	const by = next.y - curr.y;
	const cross = ax * by - ay * bx;
	const dot = ax * bx + ay * by;
	if (cross === 0 && dot === 0) return 0; // duplicate vertex
	return (Math.atan2(cross, dot) * 180) / Math.PI;
}

type Circle = { center: Pt; radius: number; maxErrorFt: number };

/** Algebraic (Kasa) least-squares circle through a point run.
 *
 * Minimises the algebraic residual x^2+y^2 - (Ax+By+C), which linearises to a 2x2
 * solve once the points are centred on their own mean. Geometric least squares
 * would be marginally better conditioned on a short arc, but it is iterative, and
 * at 0.0028 ft of residual on an 88 deg sweep there is nothing left to win.
 *
 * Centring first is not cosmetic: site coordinates are large, and x^2+y^2 on raw
 * feet loses the mantissa bits the fit is trying to resolve. */
function fitCircle(points: readonly Pt[]): Circle | null
{
	const n = points.length;
	let mx = 0;
	let my = 0;
	for (const p of points)
	{
		mx += p.x;
		my += p.y;
	}
	mx /= n;
	my /= n;

	let suu = 0;
	let svv = 0;
	let suv = 0;
	let suuu = 0;
	let svvv = 0;
	let suvv = 0;
	let svuu = 0;
	for (const p of points)
	{
		const u = p.x - mx;
		const v = p.y - my;
		suu += u * u;
		svv += v * v;
		suv += u * v;
		suuu += u * u * u;
		svvv += v * v * v;
		suvv += u * v * v;
		svuu += v * u * u;
	}

	// Scale-relative, not absolute. An absolute epsilon here would carry units of
	// ft^4 — the same unit trap PORT_PLAN flags on CrossingParameter's 1e-12 —
	// and would silently change meaning if this ever ran in metres or user units.
	const det = suu * svv - suv * suv;
	const scale = suu + svv;
	if (!(Math.abs(det) > scale * scale * 1e-12)) return null; // collinear run

	const rhsU = (suuu + suvv) / 2;
	const rhsV = (svvv + svuu) / 2;
	const cu = (rhsU * svv - rhsV * suv) / det;
	const cv = (suu * rhsV - suv * rhsU) / det;
	const center = { x: cu + mx, y: cv + my };
	const radius = Math.sqrt(cu * cu + cv * cv + scale / n);
	if (!Number.isFinite(radius) || radius <= 0) return null;

	let maxErrorFt = 0;
	for (const p of points)
	{
		maxErrorFt = Math.max(maxErrorFt, Math.abs(distance(p, center) - radius));
	}
	return { center, radius, maxErrorFt };
}

/** Swept angle start -> end, taken the way the run actually bends. */
function sweepDegrees(center: Pt, start: Pt, end: Pt, turnSign: number): number
{
	const a0 = Math.atan2(start.y - center.y, start.x - center.x);
	const a1 = Math.atan2(end.y - center.y, end.x - center.x);
	const twoPi = Math.PI * 2;
	let delta = a1 - a0; // already within (-2pi, 2pi)
	if (turnSign > 0 && delta <= 0) delta += twoPi;
	if (turnSign < 0 && delta >= 0) delta -= twoPi;
	return (Math.abs(delta) * 180) / Math.PI;
}

type TurningRun = { indices: number[]; sign: number };

/** Maximal runs of consecutive turning vertices, scanned from a straight vertex
 * so a fillet straddling the ring's start index is not split in two. */
function turningRuns(ring: readonly Pt[]): TurningRun[]
{
	const n = ring.length;
	const turns = ring.map((_, i) =>
		turnDegrees(ring[(i - 1 + n) % n], ring[i], ring[(i + 1) % n])
	);

	const start = turns.findIndex((t) => Math.abs(t) < TURN_FLOOR_DEG);
	// Every vertex turns: a closed curve with no straight stretch anywhere. It has
	// no tangent points, so there is nothing here an apron mouth could anchor to.
	if (start < 0) return [];

	const runs: TurningRun[] = [];
	let current: number[] = [];
	let sign = 0;
	for (let step = 0; step < n; step++)
	{
		const i = (start + step) % n;
		const turn = turns[i];
		const magnitude = Math.abs(turn);
		const turning = magnitude >= TURN_FLOOR_DEG && magnitude < TURN_CEILING_DEG;

		if (turning && (current.length === 0 || Math.sign(turn) === sign))
		{
			sign = Math.sign(turn);
			current.push(i);
			continue;
		}
		if (current.length > 0) runs.push({ indices: current, sign });
		// A vertex bending the other way opens its own run rather than being lost.
		current = turning ? [i] : [];
		sign = turning ? Math.sign(turn) : 0;
	}
	if (current.length > 0) runs.push({ indices: current, sign });
	return runs;
}

/** Recovers arcs from a tessellated outline. Exported so the UI can draw what was
 * refit and at what error — an apron built on a fitted arc should be inspectable.
 *
 * The run's own first and last vertices are used as tangent points, NOT their
 * projections onto the fitted circle. Two reasons. They are already within the
 * fit error of the circle, which is below MouthTrim. And they lie exactly on the
 * polygon, which the mouth's `covers` test depends on — projecting could push a
 * tangent point a hair outside the paving and make the apron vanish, the exact
 * rotation-sensitive failure MouthTrim exists to prevent.
 *
 * A tangent point is itself a turning vertex, so it falls inside the run: where a
 * straight meets an arc tangentially the direction changes by half a chord's
 * subtended angle, ~1.3 deg for the measured returns — well above the floor. */
export function refit_boundary_arcs(ring: readonly Pt[]): ArcRefit
{
	const arcs: BoundaryArc[] = [];
	const rejected: RefitRejection[] = [];
	if (ring.length < MIN_RUN_VERTICES + 2) return { arcs, rejected, vertexCount: ring.length };

	for (const run of turningRuns(ring))
	{
		const vertexCount = run.indices.length;
		if (vertexCount < MIN_RUN_VERTICES)
		{
			// Under three points no circle exists at all, so a one- or two-vertex run
			// is coordinate rounding rather than a rejected arc. Measured: the same
			// outline rotated 20 deg and rounded to the export's precision throws off
			// 91 of them alongside its 2 real arcs, and listing those buries the
			// diagnostic this field exists to carry.
			if (vertexCount >= 3)
			{
				rejected.push({
					vertexCount,
					reason: `${vertexCount} turning vertices, needs ${MIN_RUN_VERTICES} — too short to tell an arc from chained noise`,
				});
			}
			continue;
		}

		const points = run.indices.map((i) => ring[i]);
		const circle = fitCircle(points);
		if (!circle)
		{
			rejected.push({ vertexCount, reason: "run is collinear — no circle is determined" });
			continue;
		}
		if (!(circle.maxErrorFt <= MOUTH_TRIM))
		{
			rejected.push({
				vertexCount,
				reason: `fit error ${circle.maxErrorFt.toFixed(4)}ft is not below the ${MOUTH_TRIM}ft mouth trim — the tangent points would not be trustworthy`,
			});
			continue;
		}

		const start = points[0];
		const end = points[points.length - 1];
		arcs.push({
			start,
			end,
			center: circle.center,
			radius: circle.radius,
			sweepDeg: sweepDegrees(circle.center, start, end, run.sign),
			fitErrorFt: circle.maxErrorFt,
			vertexCount,
			source: "refit",
		});
	}
	return { arcs, rejected, vertexCount: ring.length };
}

/* ------------------------------------------------- method 1: throat test -- */

/** A real apron's mouth is the drive's throat: the paving's own cross-section at
 * the point the flare begins. The medial axis makes that testable with no
 * shape-specific dimension involved. The local width at a spine point is the
 * NARROWEST chord across the paving there — it is the inscribed circle's diameter
 * — so every chord is at least the local width, and a chord matches it only when
 * it genuinely is the cross-section. A diagonal slicing across an interior corner
 * is longer than the paving is wide where it crosses the spine, and that is what
 * gives it away.
 *
 * Measured on the real footprints: a true apron mouth came to 1.04x the local
 * width, and stayed there across two rotations of the same shape — even though
 * its two fillets are different sizes (r=7.27 one side, r=13.76 the other), so
 * its tangent points are not symmetric. The nearest false mouth, the diagonal
 * across the filleted notch corner that this test exists to reject, came to
 * 1.28x, and the remaining false ones to 1.55x, 1.95x and 2.09x. 1.15 sits in the
 * middle of that gap with real margin on both sides. Carried verbatim from the
 * C#: do not tighten it toward 1.04.
 *
 * A mouth the spine never crosses is not a cross-section of anything, so it is
 * rejected outright — that alone removes the chord lying along the notch's own
 * ceiling. */
const THROAT_WIDTH_RATIO = 1.15;

type ThroatApron = {
	mouthA: Pt;
	mouthB: Pt;
	inside: Pt;
	outerWidth: number;
	fillets: [BoundaryArc, BoundaryArc];
	/** Mouth width over local width at the tightest spine crossing. */
	widthRatio: number;
};

function midpoint(a: Pt, b: Pt): Pt
{
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Where the spine edge p->q crosses the mouth, as a fraction along p->q —
 * negative when the two segments do not meet at all.
 *
 * The 1e-12 is carried verbatim from the C#, where it guards a 2D cross product
 * with units of ft^2. That is only safe because this module's contract is FEET;
 * in user units it would start accepting parallel spine edges as crossings. */
function crossingParameter(mouthA: Pt, mouthB: Pt, p: Pt, q: Pt): number
{
	const mx = mouthB.x - mouthA.x;
	const my = mouthB.y - mouthA.y;
	const ex = q.x - p.x;
	const ey = q.y - p.y;
	const denom = mx * ey - my * ex;
	if (Math.abs(denom) < 1e-12) return -1; // spine edge runs along the mouth

	const onMouth = ((p.x - mouthA.x) * ey - (p.y - mouthA.y) * ex) / denom;
	const onEdge = ((p.x - mouthA.x) * my - (p.y - mouthA.y) * mx) / denom;
	if (onMouth < 0 || onMouth > 1 || onEdge < 0 || onEdge > 1) return -1;
	return onEdge;
}

/** Tightest mouth-to-local-width ratio over every spine crossing, or null when
 * the spine never crosses the mouth. The C# returns a bool; the ratio itself is
 * kept so a finding can state what it measured instead of only that it passed. */
function throatRatio(
	mouthA: Pt,
	mouthB: Pt,
	graph: SkeletonGraph,
	profile: WidthProfile
): number | null
{
	const mouthWidth = distance(mouthA, mouthB);
	let best: number | null = null;
	for (const [a, b] of graph.edges)
	{
		const t = crossingParameter(mouthA, mouthB, graph.nodes[a], graph.nodes[b]);
		if (t < 0) continue;
		const localWidth = profile.at(a) * (1 - t) + profile.at(b) * t;
		const ratio = localWidth > 0 ? mouthWidth / localWidth : Infinity;
		if (best === null || ratio < best) best = ratio;
	}
	return best;
}

/** "...flares out with fillets AND ENDS in a wider segment." Flaring alone is not
 * enough: a pair of fillets at an interior corner also widens outward and also
 * spans the paving, and it produced a false apron on a filleted staple — a
 * diagonal chord across the corner, with the entire rest of the drive lying
 * beyond it. What separates a real apron is that the drive STOPS there: the
 * paving beyond the mouth is a shallow flare, wider than it is deep.
 *
 * Depth is compared against outerWidth, not the mouth width: the mouth is the
 * narrow throat, so a genuine apron is naturally deeper than its mouth is wide
 * (measured: throat 15 ft, flare opening to 90 ft, depth 40 ft). Against the
 * width it actually opens to, a real apron is a shallow fan (40 < 90) while a
 * false mouth has the whole remaining drive beyond it.
 *
 * Only nodes within the flare's own span are measured — an unrelated arm of the
 * footprint off to one side must not make a genuine apron look deep. */
function endsHere(apron: Omit<ThroatApron, "fillets" | "widthRatio">, nodes: readonly Pt[]): boolean
{
	if (nodes.length === 0) return true;

	const frame = mouthFrame(apron.mouthA, apron.mouthB, apron.inside);
	if (!frame) return false;

	const halfSpan = apron.outerWidth / 2;
	let deepest = 0;
	for (const node of nodes)
	{
		const dx = node.x - frame.origin.x;
		const dy = node.y - frame.origin.y;
		if (Math.abs(dx * frame.ax + dy * frame.ay) > halfSpan) continue;
		const depth = dx * frame.nx + dy * frame.ny;
		if (depth > deepest) deepest = depth;
	}
	return deepest <= apron.outerWidth;
}

type MouthFrame = { origin: Pt; ax: number; ay: number; nx: number; ny: number };

/** Mouth midpoint, the unit vector along the mouth, and the normal oriented into
 * the apron. Both the depth test and the cross-method agreement test work in this
 * frame, so they are guaranteed to be talking about the same apron. */
function mouthFrame(mouthA: Pt, mouthB: Pt, inside: Pt): MouthFrame | null
{
	const width = distance(mouthA, mouthB);
	if (!(width > 0)) return null;

	const ax = (mouthB.x - mouthA.x) / width;
	const ay = (mouthB.y - mouthA.y) / width;
	let nx = -ay;
	let ny = ax;
	const origin = midpoint(mouthA, mouthB);
	if ((inside.x - origin.x) * nx + (inside.y - origin.y) * ny < 0)
	{
		nx = -nx;
		ny = -ny;
	}
	return { origin, ax, ay, nx, ny };
}

/** The two tangent points have to actually face each other across the paving, not
 * merely happen to widen — otherwise arcs from opposite ends of a footprint would
 * pair up. Tested on a slightly shortened copy of the mouth; see MOUTH_TRIM. */
function spansPaving(polygon: JtsPolygon, a: Pt, b: Pt): boolean
{
	const length = distance(a, b);
	if (length <= 2 * MOUTH_TRIM) return false;

	const tx = ((b.x - a.x) / length) * MOUTH_TRIM;
	const ty = ((b.y - a.y) / length) * MOUTH_TRIM;
	const inner = lineFactory.createLineString([
		coord(a.x + tx, a.y + ty),
		coord(b.x - tx, b.y - ty),
	]);
	return polygon.covers(inner);
}

/** Two fillets form an apron when the pair of tangent points that can see each
 * other across the paving is CLOSER together than the pair at their other ends —
 * i.e. the footprint genuinely widens on the way out. That one comparison is
 * "flares out with fillets and ends in a wider segment than the drive itself",
 * and it needs no tuned threshold: either the far end is wider or it isn't. */
function tryPair(
	polygon: JtsPolygon,
	a: BoundaryArc,
	b: BoundaryArc
): Omit<ThroatApron, "widthRatio"> | null
{
	const candidates: { mouth: [Pt, Pt]; far: [Pt, Pt] }[] = [
		{ mouth: [a.start, b.start], far: [a.end, b.end] },
		{ mouth: [a.start, b.end], far: [a.end, b.start] },
		{ mouth: [a.end, b.start], far: [a.start, b.end] },
		{ mouth: [a.end, b.end], far: [a.start, b.start] },
	];

	let best: Omit<ThroatApron, "widthRatio"> | null = null;
	let bestMouth = Number.POSITIVE_INFINITY;

	for (const { mouth, far } of candidates)
	{
		const mouthWidth = distance(mouth[0], mouth[1]);
		const farWidth = distance(far[0], far[1]);

		if (farWidth <= mouthWidth) continue; // doesn't widen — not a flare
		if (mouthWidth >= bestMouth) continue; // a tighter throat already found for this pair
		if (!spansPaving(polygon, mouth[0], mouth[1])) continue;

		best = {
			mouthA: mouth[0],
			mouthB: mouth[1],
			inside: midpoint(midpoint(mouth[0], mouth[1]), midpoint(far[0], far[1])),
			outerWidth: farWidth,
			fillets: [a, b],
		};
		bestMouth = mouthWidth;
	}
	return best;
}

function throatAprons(
	polygon: JtsPolygon,
	arcs: readonly BoundaryArc[],
	graph: SkeletonGraph,
	profile: WidthProfile
): ThroatApron[]
{
	const found: ThroatApron[] = [];
	for (let i = 0; i < arcs.length; i++)
	{
		for (let j = i + 1; j < arcs.length; j++)
		{
			const apron = tryPair(polygon, arcs[i], arcs[j]);
			if (!apron) continue;
			const ratio = throatRatio(apron.mouthA, apron.mouthB, graph, profile);
			if (ratio === null || ratio > THROAT_WIDTH_RATIO) continue;
			if (!endsHere(apron, graph.nodes)) continue;
			// No structural dedup, matching the C#: one physical flare may legitimately
			// yield two Aprons and downstream masks it. Adding dedup here would be a
			// behavioural change disguised as tidying.
			found.push({ ...apron, widthRatio: ratio });
		}
	}
	return found;
}

/* --------------------------------------------- method 2: plot-line trim -- */

/** Numerical noise floor in square feet — the same role as median-finder's
 * MIN_GAP_AREA, and NOT a judgement about how small an apron can be. A plot line
 * drawn a hair off the paving edge leaves ribbons of a few hundredths of a foot
 * wide; anything above this is real geometry. If larger slivers ever appear, fix
 * the input precision rather than raising this. */
const MIN_PIECE_AREA_SQFT = 0.5;

export type OutsidePiece = {
	/** Exterior ring of the paving outside the plot line, in feet. */
	ring: Pt[];
	areaSqFt: number;
	/** The cut across the plot line — this method's equivalent of the mouth. */
	cutA: Pt;
	cutB: Pt;
	/** Widest extent of the piece measured parallel to the cut. */
	outerWidth: number;
};

/** Farthest-apart pair in a point set. The cut is the piece's contact with the
 * plot line, and where the plot line clips a fan that contact is a chord; its
 * extreme points are the cut's two ends. */
function widestPair(points: readonly Pt[]): [Pt, Pt] | null
{
	if (points.length < 2) return null;
	let best: [Pt, Pt] = [points[0], points[1]];
	let bestLength = -1;
	for (let i = 0; i < points.length; i++)
	{
		for (let j = i + 1; j < points.length; j++)
		{
			const length = distance(points[i], points[j]);
			if (length > bestLength)
			{
				bestLength = length;
				best = [points[i], points[j]];
			}
		}
	}
	return bestLength > 0 ? best : null;
}

/** Extent of a ring measured along the direction a->b. */
function spanAlong(ring: readonly Pt[], a: Pt, b: Pt): number
{
	const length = distance(a, b);
	if (!(length > 0)) return 0;
	const ax = (b.x - a.x) / length;
	const ay = (b.y - a.y) / length;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const p of ring)
	{
		const along = p.x * ax + p.y * ay;
		min = Math.min(min, along);
		max = Math.max(max, along);
	}
	return max - min;
}

function outsidePiece(piece: JtsPolygon, plotRing: JtsGeometry): OutsidePiece | null
{
	const ring = ringPoints(piece.getExteriorRing());
	if (ring.length < 3) return null;

	// The piece's boundary shares the cut with the plot line, so intersecting the
	// two recovers it exactly. Where the overlay degenerates (a cut reduced to one
	// touching point), fall back to the piece's own widest chord, which is the
	// fan's opening in every case observed.
	const shared = piece.getExteriorRing().intersection(plotRing).getCoordinates()
		.map((c) => ({ x: c.x, y: c.y }));
	const cut = widestPair(shared) ?? widestPair(ring);
	if (!cut) return null;

	return {
		ring,
		areaSqFt: piece.getArea(),
		cutA: cut[0],
		cutB: cut[1],
		outerWidth: spanAlong(ring, cut[0], cut[1]),
	};
}

export type PlotCause =
	| "no-plot-line"
	| "plot-not-a-ring"
	| "plot-misses-paving"
	| "overlay-failed";

export type PlotStatus =
	| { ran: true; pieces: OutsidePiece[]; found: number }
	| { ran: false; cause: PlotCause; detail: string };

/** Distinct vertices, ignoring a repeated closing point. A ring needs three. */
function distinctCount(points: readonly Pt[]): number
{
	const seen = new Set<string>();
	for (const p of points) seen.add(`${p.x},${p.y}`);
	return seen.size;
}

function plotTrim(paving: JtsPolygon, plot: readonly Pt[] | null | undefined): PlotStatus
{
	if (!plot || plot.length === 0)
	{
		return {
			ran: false,
			cause: "no-plot-line",
			detail: "no plot outline was supplied, so paving outside the property line could not be measured",
		};
	}

	const distinct = distinctCount(plot);
	if (distinct < 3)
	{
		return {
			ran: false,
			cause: "plot-not-a-ring",
			detail: `the plot outline has ${distinct} distinct point(s); a closed ring needs at least 3. A dash-dot property line commonly imports as separate 2-point segments that must be stitched into a ring first`,
		};
	}

	try
	{
		const plotPolygon = polygon_from_ring(plot);
		if (!(plotPolygon.getArea() > 0))
		{
			return {
				ran: false,
				cause: "plot-not-a-ring",
				detail: "the plot outline encloses no area — its points are collinear or it never closes",
			};
		}

		// Without this, a plot line in the wrong units or the wrong place lands clear
		// of the paving, difference() returns the WHOLE drive, and the entire drive
		// is reported as apron with total confidence. Overlap is the cheapest
		// possible check that the two geometries are talking about the same site.
		if (!(paving.intersection(plotPolygon).getArea() > MIN_PIECE_AREA_SQFT))
		{
			return {
				ran: false,
				cause: "plot-misses-paving",
				detail: "the plot outline does not overlap the paving at all — check that both are in feet and share an origin",
			};
		}

		const plotRing = plotPolygon.getExteriorRing();
		const outside = paving.difference(plotPolygon);
		const pieces: OutsidePiece[] = [];
		for (let i = 0; i < outside.getNumGeometries(); i++)
		{
			const part = outside.getGeometryN(i);
			if (part.getGeometryType() !== "Polygon") continue;
			if (part.isEmpty() || part.getArea() < MIN_PIECE_AREA_SQFT) continue;
			const piece = outsidePiece(part as JtsPolygon, plotRing);
			if (piece) pieces.push(piece);
		}
		return { ran: true, pieces, found: pieces.length };
	}
	catch (error)
	{
		// Same reasoning as the skeleton extractor's final attempt: swallowing this
		// would hand back "no apron outside the plot line", which is a claim about
		// the plan rather than about the overlay that failed.
		if (!is_topology_failure(error)) throw error;
		return {
			ran: false,
			cause: "overlay-failed",
			detail: `the paving/plot overlay failed numerically (${(error as Error).name}) — the plot ring is probably self-intersecting`,
		};
	}
}

/* ------------------------------------------------------------- combining -- */

export type ApronMethod = "throat" | "plot-trim";

export type ThroatCause = "no-arc-data" | "no-skeleton";

export type ThroatStatus =
	| { ran: true; arcs: BoundaryArc[]; rejected: RefitRejection[]; found: number }
	| { ran: false; cause: ThroatCause; detail: string; arcs: BoundaryArc[]; rejected: RefitRejection[] };

export type ApronFinding = {
	/** The cut across the throat, where the flare begins. For a plot-trim-only
	 * finding this is the cut across the property line instead — the same thing
	 * one step further out. */
	mouthA: Pt;
	mouthB: Pt;
	/** A point known to sit within the apron, for recognising which split face is
	 * the apron downstream. Null when only the plot-line trim fired: that method
	 * hands back the region itself, so no probe point is needed or invented. */
	inside: Pt | null;
	/** How wide the flare has opened by its far end. That, not the mouth width, is
	 * the apron's characteristic size. */
	outerWidth: number;
	/** The two fillets whose tangent points are the mouth. Null when only the
	 * plot-line trim fired. Their `source` says whether they were refit. */
	fillets: [BoundaryArc, BoundaryArc] | null;
	/** Paving outside the plot line, as a ring in feet. Null when only the throat
	 * test fired. */
	outsideRing: Pt[] | null;
	outsideAreaSqFt: number | null;
	/** Vertex average, for anchoring a label — same convention as runCentroid in
	 * index.ts. Not guaranteed to lie inside a concave region; use `inside` for
	 * anything that must be a containment probe. */
	labelAnchor: Pt;
	methods: ApronMethod[];
	confidence: "confirmed" | "probable";
	reason: string;
};

/** `indeterminate` is the state this file exists to make impossible to ignore: at
 * least one method could not run, so "no apron" was never actually tested. */
export type ApronVerdict = "aprons-found" | "no-apron" | "indeterminate";

export type ApronResult = {
	aprons: ApronFinding[];
	throat: ThroatStatus;
	plotTrim: PlotStatus;
	verdict: ApronVerdict;
	/** One line fit to show a user, naming every test that could not run. */
	summary: string;
};

export type ApronOptions = {
	/** True arcs, when the ingest carried any — an SVG `A` command converts
	 * exactly to centre/radius, and its endpoints ARE the tangent points when the
	 * drafter drew tangent fillets. Supplying these skips refitting entirely. */
	arcs?: readonly BoundaryArc[];
	/** The plot/property boundary as a closed ring in FEET. Omit, or pass null,
	 * when the plan has no usable one — that is a supported, reported state, not an
	 * error. */
	plot?: readonly Pt[] | null;
};

function average(points: readonly Pt[]): Pt
{
	const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
	return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Does an outside piece describe the same apron as a throat mouth?
 *
 * Both are expressed in the mouth's own frame and compared as interval overlap:
 * the piece must reach across some of the flare's span and lie within the depth
 * the flare is allowed to have. Both bounds are the ones endsHere already uses —
 * outerWidth/2 laterally and outerWidth deep — so agreement introduces no new
 * threshold of its own. Overlap rather than containment is deliberate: the plot
 * line usually cuts the fan part-way, so the piece is a SUBSET of the throat
 * apron, and it may also run a little behind the mouth. */
function agrees(apron: ThroatApron, piece: OutsidePiece): boolean
{
	const frame = mouthFrame(apron.mouthA, apron.mouthB, apron.inside);
	if (!frame) return false;

	let alongMin = Number.POSITIVE_INFINITY;
	let alongMax = Number.NEGATIVE_INFINITY;
	let depthMin = Number.POSITIVE_INFINITY;
	let depthMax = Number.NEGATIVE_INFINITY;
	for (const p of piece.ring)
	{
		const dx = p.x - frame.origin.x;
		const dy = p.y - frame.origin.y;
		const along = dx * frame.ax + dy * frame.ay;
		const depth = dx * frame.nx + dy * frame.ny;
		alongMin = Math.min(alongMin, along);
		alongMax = Math.max(alongMax, along);
		depthMin = Math.min(depthMin, depth);
		depthMax = Math.max(depthMax, depth);
	}

	const halfSpan = apron.outerWidth / 2;
	return (
		alongMax >= -halfSpan &&
		alongMin <= halfSpan &&
		depthMax >= -MOUTH_TRIM &&
		depthMin <= apron.outerWidth
	);
}

function confirmedFinding(apron: ThroatApron, piece: OutsidePiece): ApronFinding
{
	return {
		mouthA: apron.mouthA,
		mouthB: apron.mouthB,
		inside: apron.inside,
		outerWidth: apron.outerWidth,
		fillets: apron.fillets,
		outsideRing: piece.ring,
		outsideAreaSqFt: piece.areaSqFt,
		labelAnchor: average(piece.ring),
		methods: ["throat", "plot-trim"],
		confidence: "confirmed",
		reason:
			`mouth ${distance(apron.mouthA, apron.mouthB).toFixed(1)}ft = ` +
			`${apron.widthRatio.toFixed(2)}x local width between fillets ` +
			`r=${apron.fillets[0].radius.toFixed(1)}ft and r=${apron.fillets[1].radius.toFixed(1)}ft; ` +
			`${piece.areaSqFt.toFixed(0)} sq ft of it lies outside the plot line`,
	};
}

function throatOnlyFinding(apron: ThroatApron, plotDetail: string): ApronFinding
{
	return {
		mouthA: apron.mouthA,
		mouthB: apron.mouthB,
		inside: apron.inside,
		outerWidth: apron.outerWidth,
		fillets: apron.fillets,
		outsideRing: null,
		outsideAreaSqFt: null,
		labelAnchor: average([apron.mouthA, apron.mouthB, apron.inside]),
		methods: ["throat"],
		confidence: "probable",
		reason:
			`throat test only — mouth ${distance(apron.mouthA, apron.mouthB).toFixed(1)}ft = ` +
			`${apron.widthRatio.toFixed(2)}x local width, flaring to ${apron.outerWidth.toFixed(1)}ft. ` +
			`Not cross-checked against the plot line: ${plotDetail}`,
	};
}

function plotOnlyFinding(piece: OutsidePiece, throatDetail: string): ApronFinding
{
	return {
		mouthA: piece.cutA,
		mouthB: piece.cutB,
		inside: null,
		outerWidth: piece.outerWidth,
		fillets: null,
		outsideRing: piece.ring,
		outsideAreaSqFt: piece.areaSqFt,
		labelAnchor: average(piece.ring),
		methods: ["plot-trim"],
		confidence: "probable",
		reason:
			`plot-line trim only — ${piece.areaSqFt.toFixed(0)} sq ft of paving lies outside the ` +
			`property line, ${piece.outerWidth.toFixed(1)}ft wide at the cut. ` +
			`Not cross-checked against the fillets: ${throatDetail}`,
	};
}

function summarise(aprons: readonly ApronFinding[], throat: ThroatStatus, plot: PlotStatus): string
{
	const blocked: string[] = [];
	if (!throat.ran) blocked.push(`the throat test could not run — ${throat.detail}`);
	if (!plot.ran) blocked.push(`the plot-line trim could not run — ${plot.detail}`);
	const blockedText = blocked.join("; and ");

	if (aprons.length === 0)
	{
		if (blocked.length === 2) return `Apron detection unavailable: ${blockedText}.`;
		if (blocked.length === 1)
		{
			return (
				`Apron detection incomplete: ${blockedText}. The other test found none, which on ` +
				`its own is not evidence that this plan has no apron.`
			);
		}
		return "No apron: both the throat test and the plot-line trim ran, and neither found one.";
	}

	const confirmed = aprons.filter((a) => a.confidence === "confirmed").length;
	const probable = aprons.length - confirmed;
	const parts: string[] = [];
	if (confirmed > 0) parts.push(`${confirmed} confirmed by both tests`);
	if (probable > 0) parts.push(`${probable} probable (one test only)`);
	const noun = aprons.length === 1 ? "apron" : "aprons";
	const tail = blocked.length > 0 ? ` Note: ${blockedText}.` : "";
	return `${aprons.length} ${noun}: ${parts.join(", ")}.${tail}`;
}

/** Finds aprons by both methods and reports how strongly each is supported.
 *
 * `paving` must be the BRIDGED analysis polygon — the same one the skeleton and
 * widths were computed from, not the raw paving. MedianFinder records the median
 * tip ending 0.002 ft from the apron mouth: on raw paving the mouth crosses 2.13
 * ft of grass, spansPaving rejects it, and the apron disappears with no error.
 *
 * Everything is in FEET. Every constant in this file is absolute, and the 1e-12
 * guard in crossingParameter has units of ft^2 — running this in SVG user units
 * produces plausible, wrong answers. */
export function find_aprons(
	paving: JtsPolygon,
	graph: SkeletonGraph,
	profile: WidthProfile,
	options: ApronOptions = {}
): ApronResult
{
	// Refit from the polygon's OWN exterior ring, not from the ring the caller
	// parsed: bridging a median re-nodes the outline, and the mouth's covers test
	// is against this polygon. Tangent points have to come off the same geometry.
	// Holes are not scanned — a fillet that opens a drive to the street is on the
	// outer boundary by definition.
	const refit: ArcRefit = options.arcs
		? { arcs: [...options.arcs], rejected: [], vertexCount: 0 }
		: refit_boundary_arcs(ringPoints(paving.getExteriorRing()));

	let throat: ThroatStatus;
	if (refit.arcs.length < 2)
	{
		const rejectedNote = refit.rejected.length > 0
			? `, and ${refit.rejected.length} curved run(s) failed the fit gate (${refit.rejected[0].reason})`
			: "";
		throat = {
			ran: false,
			cause: "no-arc-data",
			detail:
				`only ${refit.arcs.length} usable arc(s) in a ${refit.vertexCount}-vertex outline${rejectedNote}. ` +
				`An apron needs a fillet on each side, so the throat test had nothing to pair`,
			arcs: refit.arcs,
			rejected: refit.rejected,
		};
	}
	else if (graph.edges.length === 0)
	{
		throat = {
			ran: false,
			cause: "no-skeleton",
			detail:
				"the skeleton has no edges, so there is no local width to measure a mouth against",
			arcs: refit.arcs,
			rejected: refit.rejected,
		};
	}
	else
	{
		throat = { ran: true, arcs: refit.arcs, rejected: refit.rejected, found: 0 };
	}

	const aprons = throat.ran ? throatAprons(paving, throat.arcs, graph, profile) : [];
	if (throat.ran) throat = { ...throat, found: aprons.length };

	const plot = plotTrim(paving, options.plot);
	const pieces = plot.ran ? plot.pieces : [];

	const findings: ApronFinding[] = [];
	const claimed = new Set<number>();
	for (const apron of aprons)
	{
		const index = pieces.findIndex((piece) => agrees(apron, piece));
		if (index >= 0)
		{
			claimed.add(index);
			findings.push(confirmedFinding(apron, pieces[index]));
			continue;
		}
		// A piece may back more than one throat apron — the C# does not dedup one
		// physical flare into one Apron, and neither does this.
		findings.push(
			throatOnlyFinding(apron, plot.ran ? "no paving lies outside the plot line here" : plot.detail)
		);
	}
	for (let i = 0; i < pieces.length; i++)
	{
		if (claimed.has(i)) continue;
		findings.push(
			plotOnlyFinding(pieces[i], throat.ran ? "no fillet pair forms a throat here" : throat.detail)
		);
	}

	const verdict: ApronVerdict =
		findings.length > 0 ? "aprons-found" : throat.ran && plot.ran ? "no-apron" : "indeterminate";

	return { aprons: findings, throat, plotTrim: plot, verdict, summary: summarise(findings, throat, plot) };
}