/** Local width along the skeleton.
 *
 * Ported from Part1_Identify/Core/WidthProfile.cs. Distance from a skeleton node
 * to the nearest boundary is half the local width — every medial-axis point is
 * equidistant from two boundary points, and that distance is the inscribed
 * circle's radius. */

import type { SkeletonGraph } from "./skeleton-graph";

export class WidthProfile
{
	constructor(private readonly widths: ReadonlyMap<number, number>) {}

	/** Throws on a missing node rather than returning undefined.
	 *
	 * This is load-bearing, not defensive style. The C# indexes a Dictionary,
	 * which throws; a Map returns undefined, `(undefined + x)/2` is NaN, and
	 * every downstream comparison against NaN is false — so pruning would prune
	 * nothing, the segmenter would never split, and the classifier would return
	 * Lot, all without an error. */
	at(node: number): number
	{
		const width = this.widths.get(node);
		if (width === undefined) throw new Error(`no width for skeleton node ${node}`);
		return width;
	}

	get size(): number
	{
		return this.widths.size;
	}

	edge_width(graph: SkeletonGraph, edgeIndex: number): number
	{
		const [a, b] = graph.edges[edgeIndex];
		return (this.at(a) + this.at(b)) / 2;
	}

	/** Every width, ascending. Order-independent, so it survives the fact that
	 * node indices differ between geometry libraries. */
	sorted(): number[]
	{
		return [...this.widths.values()].sort((a, b) => a - b);
	}
}
