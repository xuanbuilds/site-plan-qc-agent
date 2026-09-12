/** The smallest rectangle that contains a shape, at any rotation.
 *
 * Needed because a parking stall is measured against the code as a rectangle,
 * but is not drawn as one: the pocket opens into the drive through a flare, and
 * an axis-aligned bounding box would also report the drawing's north as the
 * stall's depth. The smallest enclosing rectangle finds the stall's own axes.
 *
 * jsts ships MinimumDiameter for this and it does not work here - on a valid
 * 162 sq ft stall ring getDiameter() returns a zero-length segment and
 * getMinimumRectangle() then throws on a null base segment. Rotating calipers is
 * a dozen lines, so it is written out rather than worked around.
 *
 * The method is the standard one: the smallest enclosing rectangle always has a
 * side flush with an edge of the convex hull, so trying every hull edge as the
 * rectangle's axis and keeping the smallest area is exact, not approximate. */

import type { Pt } from "./skeleton-graph";

export type OrientedBox = {
	/** Shorter side, feet. */
	short_ft: number;
	/** Longer side, feet. */
	long_ft: number;
	/** Unit vector along the longer side. */
	long_axis: Pt;
};

/** Andrew's monotone chain, counter-clockwise, first point not repeated. */
function convex_hull(points: readonly Pt[]): Pt[]
{
	const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	const cross = (o: Pt, a: Pt, b: Pt) =>
		(a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

	const half = (source: readonly Pt[]) =>
	{
		const chain: Pt[] = [];
		for (const p of source)
		{
			while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0)
			{
				chain.pop();
			}
			chain.push(p);
		}
		return chain;
	};

	const lower = half(sorted);
	const upper = half([...sorted].reverse());
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function oriented_box(ring: readonly Pt[]): OrientedBox | null
{
	const hull = convex_hull(ring);
	if (hull.length < 3) return null;

	let best: OrientedBox | null = null;
	let best_area = Infinity;

	for (let i = 0; i < hull.length; i++)
	{
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		const edge = Math.hypot(b.x - a.x, b.y - a.y);
		if (edge < 1e-9) continue;

		// Measure every hull point in this edge's frame: along it, and across it.
		const ux = (b.x - a.x) / edge;
		const uy = (b.y - a.y) / edge;
		let along_min = Infinity, along_max = -Infinity;
		let across_min = Infinity, across_max = -Infinity;
		for (const p of hull)
		{
			const along = p.x * ux + p.y * uy;
			const across = -p.x * uy + p.y * ux;
			if (along < along_min) along_min = along;
			if (along > along_max) along_max = along;
			if (across < across_min) across_min = across;
			if (across > across_max) across_max = across;
		}

		const span_along = along_max - along_min;
		const span_across = across_max - across_min;
		const area = span_along * span_across;
		if (area >= best_area) continue;

		best_area = area;
		best = span_along >= span_across
			? { short_ft: span_across, long_ft: span_along, long_axis: { x: ux, y: uy } }
			: { short_ft: span_along, long_ft: span_across, long_axis: { x: -uy, y: ux } };
	}

	return best;
}
