/** Splits a pruned skeleton into runs.
 *
 * Ported from Part1_Identify/Core/RunSegmenter.cs, then extended — see
 * "junctions are not region boundaries" below.
 *
 * A new run starts at every branch node and every endpoint, not only where the
 * width changes — width alone under-determines the label, since a drive strip
 * and an aisle overlap in width. What differs is what the segment connects to.
 * This is segmentation, not classification.
 *
 * JUNCTIONS ARE NOT REGION BOUNDARIES. Seeding at every degree != 2 node caps
 * every run at the longest branch-to-branch chain in the skeleton. On a comb or
 * ladder footprint — a drive with bays opening off it — that cap is the BAY
 * PITCH, not the drive length. Measured on the townhouse plan: 32.2 ft of chain
 * at 24.0 ft of width, aspect 1.34, and the ceiling holds at 39.1 ft even with
 * the width tolerance disabled entirely, because the limit is topological. The
 * classifier's 2.5 cutoff is then unreachable however long the drive actually
 * is, and the aspect-ratio signal has been destroyed upstream of the stage that
 * measures it. Lowering the cutoff to 1.31 to compensate would sit far below the
 * 73/28 = 2.6 merged-Lot fixture, so the cutoff is not the thing to move.
 *
 * So a run now continues STRAIGHT THROUGH a junction when the junction is the
 * only reason it stopped. Three gates, each scaled off geometry already in hand
 * — the local width, and the caller's own run tolerance — rather than off any
 * new number:
 *
 *   1. It stays inside its own corridor. Sighting one local width ahead down
 *      each leg, the far point must remain within half a local width — the
 *      inscribed disk's own radius — of the other leg's line. width*sin(turn) <
 *      width/2 reduces to sin(turn) < 1/2: thirty degrees, derived rather than
 *      picked. Measured: true continuations 0.1-1.2 deg, a drive genuinely
 *      bending 17.4 deg, a genuine Y-fork 34.8 deg, another fork 48.1 deg.
 *   2. The two legs agree in width to within the same tolerance that splits a
 *      run on width. This is what keeps the change conservative: a pair that
 *      width would have separated is still separated, so only splits that were
 *      PURELY topological are removed.
 *   3. The pair carries the junction's widest corridor, again to within that
 *      tolerance. Without this the two bays FACING each other across the drive
 *      weld into a bogus cross-run — they are collinear with each other to
 *      3.5-4.9 deg, so straightness alone cannot tell a corridor from a pair of
 *      opposing notches. Width can: the bays neck to 14.9 ft, the drive never
 *      drops below 23.8 ft. A real crossroads still gets both of its pairs,
 *      because there both pairs carry the corridor.
 */

import { SkeletonGraph, distance, type Edge, type Pt } from "./skeleton-graph";
import { WidthProfile } from "./width-profile";

const edge_key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

export type CollapseResult = {
	graph: SkeletonGraph;
	profile: WidthProfile;
	junctions_collapsed: number;
};

/** Welds back together branch nodes that one degenerate medial vertex was torn
 * into.
 *
 * Where bays open off BOTH sides at the same station the local free space is a
 * plus, and the medial axis of a plus is an X: a single degree-4 vertex, its
 * disk pinned simultaneously by all four bay-mouth corners. Predicted radius
 * sqrt((mouth/2)^2 + (width/2)^2) = 13.8 ft, measured 27.7-28.0 ft across, on a
 * 24.0 ft band — so it is a real corner-pinned vertex, not an artefact. But
 * degree 4 is degenerate, and every Voronoi/Delaunay construction splits it into
 * two degree-3 vertices joined by a hair. Measured: seven such pairs, 0.037 to
 * 0.193 ft apart, exactly one per facing bay pair, against a next-shortest
 * genuine branch-to-branch chain of 20.3 ft.
 *
 * Nothing downstream recovers from the tear on its own. Pruning will not touch
 * an edge whose both ends are branch nodes, and the classifier's try_join needs
 * an IDENTICAL shared end node — precisely what the tear destroys, which is why
 * merge demonstrably reassembles the spine at the two SINGLE bays (one T, one
 * shared node) and cannot at the seven PAIRED ones.
 *
 * `resolution` is the boundary sample spacing the skeleton was built from. Two
 * skeleton features closer together than the samples that generated them are not
 * distinguishable, so this is a statement about what the graph can resolve, not
 * a cutoff fitted to a plan. Rebuild mirrors skeleton-pruning exactly. */
export function collapse_degenerate_junctions(
	graph: SkeletonGraph,
	profile: WidthProfile,
	resolution: number
): CollapseResult
{
	const degrees = graph.compute_degrees();
	const parent = graph.nodes.map((_, i) => i);
	const find = (start: number): number =>
	{
		let i = start;
		while (parent[i] !== i)
		{
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};

	let junctions_collapsed = 0;
	for (const [a, b] of graph.edges)
	{
		if (degrees[a] < 3 || degrees[b] < 3) continue;
		if (distance(graph.nodes[a], graph.nodes[b]) >= resolution) continue;
		const root_a = find(a);
		const root_b = find(b);
		if (root_a === root_b) continue;
		// Lowest index wins, so the representative is stable and `surviving`
		// below stays ascending without a sort.
		if (root_a < root_b) parent[root_b] = root_a;
		else parent[root_a] = root_b;
		junctions_collapsed++;
	}
	if (junctions_collapsed === 0) return { graph, profile, junctions_collapsed: 0 };

	const surviving = graph.nodes.map((_, i) => i).filter((i) => find(i) === i);
	const old_to_new = new Map(surviving.map((old, index) => [old, index]));
	const nodes = surviving.map((i) => graph.nodes[i]);

	const seen = new Set<string>();
	const edges: Edge[] = [];
	for (const [a, b] of graph.edges)
	{
		const ia = old_to_new.get(find(a))!;
		const ib = old_to_new.get(find(b))!;
		if (ia === ib) continue; // the hair itself
		const key = edge_key(ia, ib);
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push(ia < ib ? [ia, ib] : [ib, ia]);
	}

	// The representative keeps its own width. Cluster members sit within
	// `resolution` of each other and measured within 0.3 ft in width (27.7-28.0
	// across the seven), so averaging buys nothing and blurs what is meant to be
	// one corner-pinned disk.
	const widths = new Map(surviving.map((old) => [old_to_new.get(old)!, profile.at(old)]));

	return {
		graph: new SkeletonGraph(nodes, edges),
		profile: new WidthProfile(widths),
		junctions_collapsed,
	};
}

/** A maximal degree-2 path, from one branch node or endpoint to the next. */
type Chain = {
	nodes: number[];
	from: number;
	to: number;
};

/** What one leg of a junction looks like from the junction outwards. */
type Sight = {
	/** Unit vector from the junction toward the sight point. */
	heading: Pt;
	/** Narrowest width over the sighted stretch, junction node excluded — that
	 * node is the junction's own disk, not the corridor's. */
	through_width: number;
};

/** Leg ids pack a chain index and which of its two ends, so `leg ^ 1` flips to
 * the other end of the same chain. Both directions of the walk need that. */
const leg_of = (chain: number, end: 0 | 1) => chain * 2 + end;

function build_chains(graph: SkeletonGraph, adjacency: Map<number, number[]>): Chain[]
{
	const chains: Chain[] = [];
	const visited_edges = new Set<string>();

	const terminals = [...adjacency.keys()].filter((i) => adjacency.get(i)!.length !== 2);
	// A closed loop with no branches has no natural seed; start anywhere.
	if (terminals.length === 0 && graph.nodes.length > 0) terminals.push(0);

	for (const start of terminals)
	{
		for (const neighbour of adjacency.get(start)!)
		{
			if (visited_edges.has(edge_key(start, neighbour))) continue;

			const nodes = [start];
			let prev = start;
			let curr = neighbour;

			// The C# has no visited check inside the walk, so a ring with no
			// degree-2 exception circles forever. In Rhino that hangs; in a browser
			// it freezes the tab unrecoverably. Bounding by the node count is a
			// deliberate divergence from the original.
			for (let step = 0; step <= graph.nodes.length; step++)
			{
				visited_edges.add(edge_key(prev, curr));
				nodes.push(curr);
				if (adjacency.get(curr)!.length !== 2) break;

				const nexts = adjacency.get(curr)!.filter((n) => n !== prev);
				if (nexts.length === 0) break;
				prev = curr;
				curr = nexts[0];
				if (curr === start) break;
			}
			chains.push({ nodes, from: nodes[0], to: nodes[nodes.length - 1] });
		}
	}
	return chains;
}

/** Chord direction and narrowest width over the first `reach` feet of a leg.
 *
 * The chord, not the first edge: boundary sampling is 2.0 ft, so a one-edge
 * tangent is Voronoi noise. Measured through-pair deviation falls 2.3 deg at a
 * 2 ft lookahead to 1.0 deg at 8 ft and 0.4 deg at 20 ft, stabilising around a
 * third of the local width — so sighting a full width ahead is comfortable
 * rather than marginal. A leg shorter than that is sighted to its far end; you
 * cannot demand better alignment evidence than the leg is long enough to give. */
function sight_leg(
	graph: SkeletonGraph,
	profile: WidthProfile,
	outward: readonly number[],
	reach: number
): Sight | null
{
	if (outward.length < 2) return null;

	const origin = graph.nodes[outward[0]];
	let travelled = 0;
	let last = 1;
	let through_width = Number.POSITIVE_INFINITY;
	for (let i = 1; i < outward.length; i++)
	{
		travelled += distance(graph.nodes[outward[i - 1]], graph.nodes[outward[i]]);
		through_width = Math.min(through_width, profile.at(outward[i]));
		last = i;
		if (travelled >= reach) break;
	}

	const target = graph.nodes[outward[last]];
	const sight = Math.hypot(target.x - origin.x, target.y - origin.y);
	// A leg whose far point sits on top of the junction has no direction to give.
	if (!(sight > 0)) return null;

	return {
		heading: { x: (target.x - origin.x) / sight, y: (target.y - origin.y) / sight },
		through_width,
	};
}

/** Pairs up legs that are one corridor passing through, keyed leg -> leg. */
function stitch_junctions(
	graph: SkeletonGraph,
	profile: WidthProfile,
	adjacency: Map<number, number[]>,
	chains: readonly Chain[],
	tolerance: number
): Map<number, number>
{
	const partners = new Map<number, number>();

	const legsAt = new Map<number, number[]>();
	chains.forEach((chain, index) =>
	{
		const ends: Array<[number, 0 | 1]> = [[chain.from, 0], [chain.to, 1]];
		for (const [node, end] of ends)
		{
			if (adjacency.get(node)!.length < 3) continue;
			if (!legsAt.has(node)) legsAt.set(node, []);
			legsAt.get(node)!.push(leg_of(index, end));
		}
	});

	for (const [junction, legs] of legsAt)
	{
		// The corridor's own scale at this junction sets both the sighting
		// distance and, at half of it, how far a continuation may stray.
		const reach = profile.at(junction);
		if (!(reach > 0)) continue;

		const sights = legs.map((leg) =>
		{
			const chain = chains[leg >> 1];
			const outward = (leg & 1) === 0 ? chain.nodes : [...chain.nodes].reverse();
			return sight_leg(graph, profile, outward, reach);
		});

		let widest = 0;
		for (const sight of sights) if (sight) widest = Math.max(widest, sight.through_width);

		const candidates: Array<{ a: number; b: number; turn: number }> = [];
		for (let i = 0; i < sights.length; i++)
		{
			for (let j = i + 1; j < sights.length; j++)
			{
				const p = sights[i];
				const q = sights[j];
				if (!p || !q) continue;

				// Straight through means the two legs leave back to back.
				const dot = p.heading.x * q.heading.x + p.heading.y * q.heading.y;
				const turn = Math.acos(Math.min(1, Math.max(-1, -dot)));

				// Gate 1, the corridor. Sighting one width ahead, the offset from
				// the other leg's line is width*sin(turn) and the corridor allows
				// width/2 — so this is sin(turn) < 1/2, i.e. asin(1/2) = 30 deg,
				// read off the inscribed disk rather than chosen.
				if (Math.sin(turn) >= 0.5) continue;

				// Gate 2. Width would have split this pair anyway, so leave it
				// split. This is the whole conservatism argument: nothing that the
				// existing width rule separates is newly joined here.
				if (Math.abs(p.through_width - q.through_width) > tolerance) continue;

				// Gate 3. The pair has to BE the corridor, not two notches facing
				// off across it. Opposing bays are collinear to 3.5-4.9 deg and
				// would sail through gate 1; they neck to 14.9 ft against the
				// drive's 23.8 ft and cannot get past this one.
				if (Math.min(p.through_width, q.through_width) < widest - tolerance) continue;

				candidates.push({ a: i, b: j, turn });
			}
		}

		// Straightest first, one leg to one partner. A genuine crossroads keeps
		// both of its pairs; a bay pair never gets one, having failed gate 3.
		candidates.sort((x, y) => x.turn - y.turn);
		const taken = new Set<number>();
		for (const candidate of candidates)
		{
			if (taken.has(candidate.a) || taken.has(candidate.b)) continue;
			taken.add(candidate.a);
			taken.add(candidate.b);
			partners.set(legs[candidate.a], legs[candidate.b]);
			partners.set(legs[candidate.b], legs[candidate.a]);
		}
	}

	return partners;
}

/** Concatenates stitched chains into the node paths the width rule then splits. */
function assemble_paths(chains: readonly Chain[], partners: Map<number, number>): number[][]
{
	const used = new Set<number>();
	const paths: number[][] = [];

	for (let seed = 0; seed < chains.length; seed++)
	{
		if (used.has(seed)) continue;

		// Back up to the head of the sequence first, so the path is emitted end to
		// end rather than from the middle. `entry` is the leg a traversal arrives
		// on; partners.get(entry) is the leg it arrived from, and `^ 1` steps to
		// that chain's own entry. Bounded by the chain count so a sequence that
		// closes on itself terminates instead of circling.
		let entry = leg_of(seed, 0);
		for (let step = 0; step < chains.length; step++)
		{
			const arrival = partners.get(entry);
			if (arrival === undefined) break;
			const previous = arrival ^ 1;
			if (previous >> 1 === seed) break;
			entry = previous;
		}

		const path: number[] = [];
		let current = entry;
		for (let step = 0; step < chains.length; step++)
		{
			const index = current >> 1;
			if (used.has(index)) break;
			used.add(index);

			const chain = chains[index];
			const ordered = (current & 1) === 0 ? chain.nodes : [...chain.nodes].reverse();
			// The junction node is already the last node of the chain just laid down.
			for (const node of path.length === 0 ? ordered : ordered.slice(1)) path.push(node);

			const next = partners.get(current ^ 1);
			if (next === undefined) break;
			current = next;
		}
		if (path.length > 0) paths.push(path);
	}

	return paths;
}

/** Splits one assembled path wherever width crosses tolerance.
 *
 * Unchanged from the original for every degree-2 node, including the reason it
 * splits rather than stops: stopping outright drops whatever lies beyond when a
 * chain has more than one transition — found on a staple shape, where pruning
 * left the crossbar's core past both legs' crossings and unclaimed.
 *
 * The exemption is the original's too, only relocated. A junction node was
 * already exempt via `!reachedSeed`; it still has to be, because its disk is
 * pinned by the junction's own corners and measures 27.8 ft where the drive is
 * 24.0 — a 3.8 ft departure against a 3.0 ft tolerance, which would re-chop the
 * spine at every single bay. A junction disk is not a width transition. It only
 * needs saying out loud now that a junction is no longer where a run stops. */
function split_on_width(
	profile: WidthProfile,
	adjacency: Map<number, number[]>,
	path: readonly number[],
	tolerance: number,
	out: number[][]
): void
{
	if (path.length === 0) return;

	let run = [path[0]];
	let runStartWidth = profile.at(path[0]);

	for (let i = 1; i < path.length; i++)
	{
		const node = path[i];
		run.push(node);

		if (i === path.length - 1) break;
		if (adjacency.get(node)!.length !== 2) continue;
		if (Math.abs(profile.at(node) - runStartWidth) <= tolerance) continue;

		out.push(run);
		run = [node];
		runStartWidth = profile.at(node);
	}
	out.push(run);
}

export function constant_width_runs(
	graph: SkeletonGraph,
	profile: WidthProfile,
	tolerance: number
): number[][]
{
	const adjacency = graph.build_adjacency();
	const chains = build_chains(graph, adjacency);
	const partners = stitch_junctions(graph, profile, adjacency, chains, tolerance);
	const paths = assemble_paths(chains, partners);

	const runs: number[][] = [];
	for (const path of paths) split_on_width(profile, adjacency, path, tolerance, runs);
	return runs;
}


