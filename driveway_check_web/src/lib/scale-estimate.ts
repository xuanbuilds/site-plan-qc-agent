/** Estimating a plan's scale from its parking stripes.
 *
 * Most plans declare no scale: 448 of the 483 in the production corpus. But
 * nearly every one draws parking, and a standard stall is 9 ft wide - Table 9-2,
 * and what cedarOS draws: measured 9.00 x 18.00 ft on option_1, 10.36 x 20.73
 * drawing units on option_4, both 2:1. The stripes between stalls are the most
 * numerous equal-length lines on a sheet, parallel, at a constant pitch, and the
 * pitch IS the stall width. So pitch / 9 is the scale in drawing units per foot.
 *
 * It is an estimate and is offered as one. It assumes standard stalls - a lot
 * drawn at 8.5 ft would read 6% large - so the declared scale is used wherever a
 * plan carries one, and where it does not the estimate is put to the user for
 * confirmation the way the parking angle is, never applied silently. The 35
 * declared plans in the corpus are the check on it.
 *
 * Coordinates are read raw, without <g transform>: the paving detector reads
 * them the same way, and every plan seen so far draws in root coordinates. */

export type ScaleEstimate = {
	px_per_ft: number;
	/** Stripes that agreed on the pitch. */
	stripes: number;
	pitch_units: number;
	stripe_units: number;
	/** pitch / stripe length. A stall is about 2:1, so about 0.5. */
	ratio: number;
};

/** Standard stall width, feet (Table 9-2). Kept local so this module has no
 * dependency on the identification pipeline. */
const STALL_WIDTH_FT = 9;
/** Fewer stripes than this and one row of stalls could be anything. */
const MIN_STRIPES = 8;
/** Lengths within this of each other are the same drawn length. Generated
 * stripes are identical to many decimals; hand-drawn ones are not. */
const SAME_LENGTH = 0.01;
/** Pitch agreement, and what share of a group must agree. */
const SAME_PITCH = 0.02;
const MIN_AGREEMENT = 0.5;
/** Stall width over depth: 8.5-9.5 ft across 16-20 ft deep spans 0.42-0.59;
 * parallel stalls (8.5 x 22) sit at 0.39. Outside this it is not a stall. */
const RATIO_MIN = 0.35;
const RATIO_MAX = 0.65;

type Segment = { x1: number; y1: number; x2: number; y2: number; len: number; ux: number; uy: number };

const NUMBER = /-?\d+\.?\d*(?:e[+-]?\d+)?/gi;

function segment(x1: number, y1: number, x2: number, y2: number): Segment | null
{
	const len = Math.hypot(x2 - x1, y2 - y1);
	if (!(len > 0) || ![x1, y1, x2, y2].every(Number.isFinite)) return null;
	return { x1, y1, x2, y2, len, ux: (x2 - x1) / len, uy: (y2 - y1) / len };
}

/** Every straight two-point element: <line>, a two-vertex <polyline>, or a
 * <path> that is one M and one L. Anything with more vertices is not a stripe. */
function two_point_segments(svg: Element): Segment[]
{
	const out: Segment[] = [];
	svg.querySelectorAll("line").forEach((el) =>
	{
		const s = segment(+el.getAttribute("x1")!, +el.getAttribute("y1")!, +el.getAttribute("x2")!, +el.getAttribute("y2")!);
		if (s) out.push(s);
	});
	svg.querySelectorAll("polyline, polygon").forEach((el) =>
	{
		const n = (el.getAttribute("points") ?? "").match(NUMBER)?.map(Number);
		if (n?.length !== 4) return;
		const s = segment(n[0], n[1], n[2], n[3]);
		if (s) out.push(s);
	});
	svg.querySelectorAll("path").forEach((el) =>
	{
		const d = el.getAttribute("d") ?? "";
		if (/[^MLZmlz0-9\s.,+\-eE]/.test(d)) return;
		const n = d.match(NUMBER)?.map(Number);
		if (n?.length !== 4) return;
		const s = segment(n[0], n[1], n[2], n[3]);
		if (s) out.push(s);
	});
	return out;
}

/** Group segments by drawn length, largest groups first. */
function length_groups(segments: Segment[]): Segment[][]
{
	const sorted = [...segments].sort((a, b) => a.len - b.len);
	const groups: Segment[][] = [];
	for (const s of sorted)
	{
		const last = groups[groups.length - 1];
		if (last && Math.abs(s.len - last[0].len) <= SAME_LENGTH * last[0].len) last.push(s);
		else groups.push([s]);
	}
	return groups.filter((g) => g.length >= MIN_STRIPES).sort((a, b) => b.length - a.length);
}

/** The pitch a group of parallel lines is drawn at: each line's offset to its
 * nearest parallel neighbour, and the offset most of them share. */
function pitch_of(group: Segment[]): { pitch: number; agreeing: number } | null
{
	const offsets: number[] = [];
	for (const a of group)
	{
		let nearest = Infinity;
		for (const b of group)
		{
			if (a === b) continue;
			if (Math.abs(a.ux * b.ux + a.uy * b.uy) < 0.995) continue;
			const dx = (b.x1 + b.x2) / 2 - (a.x1 + a.x2) / 2;
			const dy = (b.y1 + b.y2) / 2 - (a.y1 + a.y2) / 2;
			const along = Math.abs(dx * a.ux + dy * a.uy);
			const across = Math.abs(-dx * a.uy + dy * a.ux);
			// Side by side, not end to end - and not the same line drawn twice.
			if (along < a.len && across > 0.05 * a.len && across < nearest) nearest = across;
		}
		if (nearest < Infinity) offsets.push(nearest);
	}
	if (offsets.length < MIN_STRIPES) return null;

	// The mode, to within SAME_PITCH: the offset that the most others sit near.
	let best = { pitch: 0, agreeing: 0 };
	for (const candidate of offsets)
	{
		const near = offsets.filter((o) => Math.abs(o - candidate) <= SAME_PITCH * candidate);
		if (near.length > best.agreeing)
		{
			best = { pitch: near.reduce((t, o) => t + o, 0) / near.length, agreeing: near.length };
		}
	}
	return best.agreeing >= MIN_STRIPES && best.agreeing / group.length >= MIN_AGREEMENT ? best : null;
}

export function estimate_scale(svg: Element): ScaleEstimate | null
{
	const groups = length_groups(two_point_segments(svg));
	let best: ScaleEstimate | null = null;
	// Several equal-length families can qualify - stripes, then the shorter
	// tick marks that share a pitch with them. The one with the most agreeing
	// lines is the stripes.
	for (const group of groups.slice(0, 6))
	{
		const found = pitch_of(group);
		if (!found) continue;
		const stripe = group[0].len;
		const ratio = found.pitch / stripe;
		if (ratio < RATIO_MIN || ratio > RATIO_MAX) continue;
		if (!best || found.agreeing > best.stripes)
		{
			best = {
				px_per_ft: found.pitch / STALL_WIDTH_FT,
				stripes: found.agreeing,
				pitch_units: found.pitch,
				stripe_units: stripe,
				ratio,
			};
		}
	}
	return best;
}
