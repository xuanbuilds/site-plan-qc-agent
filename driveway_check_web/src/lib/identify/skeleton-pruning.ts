/** Collapses spurious short branches from a raw skeleton.
 *
 * Ported from Part1_Identify/Core/SkeletonPruning.cs.
 *
 * Every reflex corner of the input polygon generates one leaf-ending spur
 * pointing at it — an artefact of the medial-axis definition, not a real zone
 * boundary. Raw extraction produced 21 runs on a 3-zone test shape.
 *
 * The rule is width-adaptive rather than a fixed length, because no fixed cutoff
 * works across a 12 ft strip and a 60 ft pad in one shape. Length alone is not
 * enough either: a compact square pad has almost no medial axis of its own (a
 * square's true medial axis is a point), so the stub leading into it looks like a
 * corner ear by length. Hence the second test on the spur's own tip width — a
 * real corner ear narrows toward the polygon vertex, a stub into a real region
 * does not. */

import { SkeletonGraph, path_length, type Edge } from "./skeleton-graph";
import { WidthProfile } from "./width-profile";

export type PruneResult = {
	graph: SkeletonGraph;
	profile: WidthProfile;
	spurs_removed: number;
};

/** A leaf spur is pruned only if BOTH hold against the width at the branch node
 * it attaches to: it is shorter than this fraction of that width... */
const LENGTH_TO_WIDTH_RATIO = 0.75;
/** ...and its own tip is narrower than this fraction of it.
 *
 * 0.5 is not a guess. Across every corner-ear spur measured, the highest ratio
 * for a genuine artefact was 0.30 — and setting the cutoff to exactly 0.3 left a
 * visible stray sliver. The lowest for a genuine structural connection was ~1.0.
 * 0.5 sits mid-gap with margin on both sides. Keep the comparison strict. */
const TIP_CONVERGENCE_RATIO = 0.5;

export function prune(
	graph: SkeletonGraph,
	profile: WidthProfile,
	lengthToWidthRatio = LENGTH_TO_WIDTH_RATIO,
	tipConvergenceRatio = TIP_CONVERGENCE_RATIO
): PruneResult
{
	const adjacency = new Map<number, Set<number>>();
	for (const [node, neighbours] of graph.build_adjacency())
	{
		adjacency.set(node, new Set(neighbours));
	}

	let totalRemoved = 0;

	// Each pass removes at least one node or breaks, and the node count is finite
	// and strictly decreasing, so this terminates.
	for (;;)
	{
		const leaves = [...adjacency.entries()].filter(([, n]) => n.size === 1).map(([i]) => i);
		if (leaves.length === 0) break;

		// Decide every removal against the snapshot as it stood at the start of the
		// pass, then apply them together. Mutating mid-pass makes a sibling ear at
		// the same branch node look like it merges into the spine, purely because
		// of iteration order.
		const toRemove: number[][] = [];
		for (const leaf of leaves)
		{
			const path = [leaf];
			let prev = leaf;
			let curr = [...adjacency.get(leaf)!][0];
			while (adjacency.get(curr)!.size === 2)
			{
				path.push(curr);
				const next = [...adjacency.get(curr)!].find((n) => n !== prev)!;
				prev = curr;
				curr = next;
			}
			path.push(curr); // a branch node, or the far leaf of an unbranched path

			const spurLength = path_length(graph, path);
			const baseWidth = profile.at(curr);
			const tipWidth = profile.at(leaf);
			const attachesToRealBranch = adjacency.get(curr)!.size >= 3;
			const isShort = spurLength < lengthToWidthRatio * baseWidth;
			const tipConverges = tipWidth < tipConvergenceRatio * baseWidth;

			if (attachesToRealBranch && isShort && tipConverges) toRemove.push(path);
		}
		if (toRemove.length === 0) break;

		for (const path of toRemove)
		{
			for (let i = 0; i < path.length - 1; i++)
			{
				adjacency.get(path[i])?.delete(path[i + 1]);
				adjacency.get(path[i + 1])?.delete(path[i]);
			}
			for (const node of path.slice(0, -1)) adjacency.delete(node);
			totalRemoved++;
		}
	}

	// Numeric sort. A bare .sort() is lexicographic (1, 10, 11, 2...), which would
	// scramble old_to_new and attach every coordinate and width to the wrong node
	// without throwing.
	const surviving = [...adjacency.keys()].sort((a, b) => a - b);
	const old_to_new = new Map(surviving.map((old, index) => [old, index]));

	const nodes = surviving.map((i) => graph.nodes[i]);
	// Adjacency is symmetric, so keeping only old < neighbour dedupes for free.
	const edges: Edge[] = [];
	for (const old of surviving)
	{
		for (const neighbour of adjacency.get(old)!)
		{
			if (old < neighbour) edges.push([old_to_new.get(old)!, old_to_new.get(neighbour)!]);
		}
	}

	const widths = new Map(surviving.map((old) => [old_to_new.get(old)!, profile.at(old)]));

	return {
		graph: new SkeletonGraph(nodes, edges),
		profile: new WidthProfile(widths),
		spurs_removed: totalRemoved,
	};
}
