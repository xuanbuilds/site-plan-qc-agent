/** Approximate medial axis extraction for a 2D footprint.
 *
 * Ported from Part1_Identify/Core/SkeletonExtractor.cs.
 *
 *   1. Densely sample the boundary (exterior + holes) into points.
 *   2. Compute the Voronoi diagram of those points.
 *   3. Keep only edges whose BOTH endpoints fall strictly inside the polygon.
 *
 * There is no ridge-vertex output, so edges are recovered from the per-site cell
 * polygons: every internal Voronoi edge is shared by exactly two adjacent cells,
 * so collecting and deduping ring segments reconstructs the same ridge graph.
 *
 * Raw output is noisy — every reflex vertex produces a spurious short branch
 * toward it. See skeleton-pruning. */

import { SkeletonGraph, type Edge, type Pt } from "./skeleton-graph";
import {
	boundary_distance,
	coord,
	interior_locator,
	interior_rings,
	is_topology_failure,
	polygon_from_ring,
	voronoi_cells,
	type JtsCoordinate,
	type JtsGeometry,
	type JtsPolygon,
} from "./jts";
import { WidthProfile } from "./width-profile";

/** The Voronoi builder throws on certain sample configurations — a degeneracy in
 * the underlying triangulation, not a flaw in the shape. Tolerance does not fix
 * it (the full 0.001-1.0 range was tried). Nor does scaling the spacing alone: a
 * real T-shape failed every attempt up to +5% because uniform scaling preserves
 * the symmetric coincidences causing it. Per-point jitter perturbs points
 * independently and does break them, so both are applied. */
const MAX_ATTEMPTS = 12;
const SPACING_GROWTH = 1.0123;
const JITTER_FRACTION = 1e-4;
/** Two cell-ring vertices closer than this fuse into one skeleton node. */
const QUANTIZE = 1e-6;
/** Same floor as the Python prototype's _sample_boundary. */
const MIN_SAMPLES_PER_RING = 8;

/** Deterministic PRNG. .NET's Random(12345) stream cannot be reproduced in JS, so
 * the sequence differs from the C# — but it is stable run to run, which is what
 * the retry actually needs. Constructed once outside the loop so state carries
 * across attempts, matching the original. */
function mulberry32(seed: number)
{
	let a = seed >>> 0;
	return () =>
	{
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function ring_length(coords: JtsCoordinate[]): number[]
{
	const cumulative = new Array<number>(coords.length).fill(0);
	for (let i = 1; i < coords.length; i++)
	{
		cumulative[i] = cumulative[i - 1] + Math.hypot(
			coords[i].x - coords[i - 1].x,
			coords[i].y - coords[i - 1].y
		);
	}
	return cumulative;
}

function point_at_length(coords: JtsCoordinate[], cumulative: number[], target: number): Pt
{
	// C# Array.BinarySearch returns the index on an exact hit and ~insertionIndex
	// otherwise; this reproduces the insertion index directly.
	let lo = 0;
	let hi = cumulative.length - 1;
	while (lo < hi)
	{
		const mid = (lo + hi) >> 1;
		if (cumulative[mid] < target) lo = mid + 1;
		else hi = mid;
	}
	const i = Math.min(Math.max(lo, 1), coords.length - 1);

	const segment = cumulative[i] - cumulative[i - 1];
	const t = segment > 1e-12 ? (target - cumulative[i - 1]) / segment : 0;
	return {
		x: coords[i - 1].x + t * (coords[i].x - coords[i - 1].x),
		y: coords[i - 1].y + t * (coords[i].y - coords[i - 1].y),
	};
}

function sample_ring(ring: JtsGeometry, spacing: number, out: Pt[]): void
{
	const coords = ring.getCoordinates();
	const cumulative = ring_length(coords);
	const length = cumulative[cumulative.length - 1];
	const n = Math.max(Math.trunc(length / spacing), MIN_SAMPLES_PER_RING);
	for (let i = 0; i < n; i++) out.push(point_at_length(coords, cumulative, (length * i) / n));
}

function sample_boundary(polygon: JtsPolygon, spacing: number): Pt[]
{
	const points: Pt[] = [];
	sample_ring(polygon.getExteriorRing(), spacing, points);
	for (const hole of interior_rings(polygon)) sample_ring(hole, spacing, points);
	return points;
}

export function extract_skeleton(polygon: JtsPolygon, sample_spacing: number): SkeletonGraph
{
	const jitter_random = mulberry32(12345);
	let cells: JtsPolygon[] = [];

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++)
	{
		let points = sample_boundary(polygon, sample_spacing * SPACING_GROWTH ** attempt);
		if (attempt > 0)
		{
			const jitter = sample_spacing * JITTER_FRACTION;
			points = points.map((p) => ({
				x: p.x + (jitter_random() - 0.5) * jitter,
				y: p.y + (jitter_random() - 0.5) * jitter,
			}));
		}
		// A single site yields no cells at all.
		if (points.length < 2) continue;
		try
		{
			// Real Coordinate instances, not plain objects: jsts calls .copy() on them
			// internally and a duck-typed {x,y} fails deep inside the triangulation.
			cells = voronoi_cells(points.map((p) => coord(p.x, p.y)));
			break;
		}
		catch (error)
		{
			// The last attempt rethrows deliberately. Swallowing it would hand
			// downstream an empty skeleton, which reads as "this footprint has no
			// medial axis" rather than as a failure.
			if (attempt === MAX_ATTEMPTS - 1 || !is_topology_failure(error)) throw error;
		}
	}

	const isInside = interior_locator(polygon);
	const node_index = new Map<string, number>();
	const nodes: Pt[] = [];
	const edge_set = new Set<string>();
	const edges: Edge[] = [];

	// Containment is the hot path — one lookup per cell-ring vertex, and vertices
	// are shared between adjacent cells. Memoising on the same key used for node
	// dedup removes tens of thousands of repeat tests.
	const containment = new Map<string, boolean>();
	const key = (c: JtsCoordinate) =>
		`${Math.round(c.x / QUANTIZE)},${Math.round(c.y / QUANTIZE)}`;

	const inside = (c: JtsCoordinate, k: string) =>
	{
		const cached = containment.get(k);
		if (cached !== undefined) return cached;
		const result = isInside(c);
		containment.set(k, result);
		return result;
	};

	const node_for = (c: JtsCoordinate, k: string) =>
	{
		const existing = node_index.get(k);
		if (existing !== undefined) return existing;
		const index = nodes.length;
		nodes.push({ x: c.x, y: c.y });
		node_index.set(k, index);
		return index;
	};

	for (const cell of cells)
	{
		const ring = cell.getExteriorRing().getCoordinates();
		for (let i = 0; i + 1 < ring.length; i++)
		{
			const c1 = ring[i];
			const c2 = ring[i + 1];
			const k1 = key(c1);
			const k2 = key(c2);
			// Discard anything touching the clip envelope or outside the footprint.
			if (!inside(c1, k1) || !inside(c2, k2)) continue;

			const i1 = node_for(c1, k1);
			const i2 = node_for(c2, k2);
			if (i1 === i2) continue;
			const edgeKey = i1 < i2 ? `${i1},${i2}` : `${i2},${i1}`;
			if (edge_set.has(edgeKey)) continue;
			edge_set.add(edgeKey);
			edges.push(i1 < i2 ? [i1, i2] : [i2, i1]);
		}
	}

	return new SkeletonGraph(nodes, edges);
}

/** Local width at every skeleton node: twice the distance to the boundary. */
export function compute_widths(polygon: JtsPolygon, graph: SkeletonGraph): WidthProfile
{
	const distanceTo = boundary_distance(polygon.getExteriorRing());
	const widths = new Map<number, number>();
	for (let i = 0; i < graph.nodes.length; i++)
	{
		const node = graph.nodes[i];
		widths.set(i, 2 * distanceTo(coord(node.x, node.y)));
	}
	return new WidthProfile(widths);
}

export { polygon_from_ring };
