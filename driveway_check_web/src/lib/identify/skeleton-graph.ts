/** Approximate medial axis, as a plain graph of points.
 *
 * Ported from Part1_Identify/Core/SkeletonGraph.cs. No geometry library here —
 * this is a data structure plus counting. */

export type Pt = { x: number; y: number };

export type Edge = [number, number];

export class SkeletonGraph
{
	constructor(
		readonly nodes: readonly Pt[],
		readonly edges: readonly Edge[]
	) {}

	compute_degrees(): number[]
	{
		const degrees = new Array<number>(this.nodes.length).fill(0);
		for (const [a, b] of this.edges)
		{
			degrees[a]++;
			degrees[b]++;
		}
		return degrees;
	}

	/** Nodes where the skeleton splits — candidate boundaries between zones. */
	branch_nodes(): number[]
	{
		const degrees = this.compute_degrees();
		return degrees.map((_, i) => i).filter((i) => degrees[i] >= 3);
	}

	/** Degree-1 nodes — drive terminations or dead-end turnarounds. */
	endpoint_nodes(): number[]
	{
		const degrees = this.compute_degrees();
		return degrees.map((_, i) => i).filter((i) => degrees[i] === 1);
	}

	/** Every index gets an entry, including isolated nodes. A lazily-filled map
	 * would hand callers undefined where the C# returns an empty list. */
	build_adjacency(): Map<number, number[]>
	{
		const adjacency = new Map<number, number[]>();
		for (let i = 0; i < this.nodes.length; i++) adjacency.set(i, []);
		for (const [a, b] of this.edges)
		{
			adjacency.get(a)!.push(b);
			adjacency.get(b)!.push(a);
		}
		return adjacency;
	}
}

export function distance(a: Pt, b: Pt): number
{
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Summed chord length along a node path. */
export function path_length(graph: SkeletonGraph, path: readonly number[]): number
{
	let total = 0;
	for (let i = 0; i + 1 < path.length; i++)
	{
		total += distance(graph.nodes[path[i]], graph.nodes[path[i + 1]]);
	}
	return total;
}
