/** The only module that imports jsts.
 *
 * jsts is the JavaScript port of JTS; NetTopologySuite is the .NET port of the
 * same JTS, so the Rhino pipeline's geometry calls map across almost name for
 * name. The differences that bite are collected here so nothing downstream has
 * to know about them.
 *
 * Three traps this file exists to close:
 *
 *  1. jsts 2.12 ships no `main`, `module` or `exports`, so `import "jsts"` fails
 *     outright. Deep ESM paths with explicit .js are mandatory. Never mix these
 *     with dist/jsts.min.js — two class identities means every instanceof
 *     silently returns false.
 *  2. Geometry shortcut methods (.buffer, .covers, .intersection, .distance)
 *     only exist after the monkey side-effect import. If a bundler tree-shakes
 *     that away you get "covers is not a function" in the production build and
 *     nowhere else. Operations that have a class form use the class instead.
 *  3. The shipped .d.ts files are `(...args: any[]) => any`, so with strict mode
 *     TypeScript catches none of the above. The interfaces below are hand-written
 *     over the ~20 members actually used.
 */

import "jsts/org/locationtech/jts/monkey.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Location from "jsts/org/locationtech/jts/geom/Location.js";
import VoronoiDiagramBuilder from "jsts/org/locationtech/jts/triangulate/VoronoiDiagramBuilder.js";
import IndexedPointInAreaLocator from "jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js";
import IndexedFacetDistance from "jsts/org/locationtech/jts/operation/distance/IndexedFacetDistance.js";
import BufferOp from "jsts/org/locationtech/jts/operation/buffer/BufferOp.js";
import BufferParameters from "jsts/org/locationtech/jts/operation/buffer/BufferParameters.js";
import PrecisionModel from "jsts/org/locationtech/jts/geom/PrecisionModel.js";
import GeometryNoder from "jsts/org/locationtech/jts/noding/snapround/GeometryNoder.js";
import Polygonizer from "jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js";
import GeometryPrecisionReducer from "jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js";
import ArrayList from "jsts/java/util/ArrayList.js";

import type { Pt } from "./skeleton-graph";

/* Minimal shapes for the members we actually call. */

export type JtsCoordinate = { x: number; y: number };

/** What merge_rings produced: the outline, how many disjoint pieces went in, and
 * the gap that had to be closed to make them one (0 when they already touched). */
export type MergedRings = {
	/** Outer boundary of the merged surface. */
	ring: Pt[];
	/** Enclosed gaps - courtyards a drive loops around. Paving's absence, and part
	 * of the answer: dropping them inflated 29c0acaf_option_1 from 124,768 to
	 * 263,056 units. */
	holes: Pt[][];
	/** How many disjoint pieces went in. */
	pieces: number;
	/** The gap that had to be closed to make them one; 0 when they already met. */
	bridged_by: number;
	/** True surface area, holes excluded. */
	area: number;
};

export type JtsGeometry = {
	getArea(): number;
	getLength(): number;
	getNumGeometries(): number;
	getGeometryN(i: number): JtsGeometry;
	isEmpty(): boolean;
	getCoordinates(): JtsCoordinate[];
	difference(other: JtsGeometry): JtsGeometry;
	union(other: JtsGeometry): JtsGeometry;
	distance(other: JtsGeometry): number;
	intersection(other: JtsGeometry): JtsGeometry;
	covers(other: JtsGeometry): boolean;
	getBoundary(): JtsGeometry;
	/** A point guaranteed to lie INSIDE the geometry, unlike a centroid, which can
	 * fall outside a concave region such as an L-shaped drive. */
	getInteriorPoint(): { getX(): number; getY(): number };
	getGeometryType(): string;
};

export type JtsPolygon = JtsGeometry & {
	getExteriorRing(): JtsGeometry;
	getNumInteriorRing(): number;
	getInteriorRingN(i: number): JtsGeometry;
};

export const factory = new GeometryFactory();

export function coord(x: number, y: number): JtsCoordinate
{
	return new Coordinate(x, y) as JtsCoordinate;
}

/** Rings arrive from the SVG as open or closed point lists; jsts needs the first
 * coordinate repeated at the end. */
export function polygon_from_ring(points: readonly Pt[], holes: readonly (readonly Pt[])[] = []): JtsPolygon
{
	const ring_of = (pts: readonly Pt[]) =>
	{
		const coords = pts.map((p) => coord(p.x, p.y));
		const first = coords[0];
		const last = coords[coords.length - 1];
		if (first.x !== last.x || first.y !== last.y) coords.push(coord(first.x, first.y));
		return factory.createLinearRing(coords);
	};
	// Holes are the courtyards a drive loops around. They are paving's absence, so
	// they must reach the pipeline: without them a building enclosed by a drive
	// reads as 138,288 units of extra surface on 29c0acaf_option_1 alone.
	return factory.createPolygon(ring_of(points), holes.map(ring_of)) as JtsPolygon;
}

/** A two-point LineString. The Rhino pipeline cut lines are Rhino.Geometry.Line;
 * this is the jsts form the noder wants. */
export function line_string(from: Pt, to: Pt): JtsGeometry
{
	return factory.createLineString([coord(from.x, from.y), coord(to.x, to.y)]) as JtsGeometry;
}

/** The inverse of java_list. jsts hands its own ArrayList back out of node() and
 * getPolygons(), and its shipped declaration types toArray() as any[], so
 * unwrapping here is what keeps that any from leaking into strict code. */
function js_array<T>(list: unknown): T[]
{
	return (list as { toArray(): T[] }).toArray();
}

/** Snap-rounded noding followed by polygonization: a footprint split along its own
 * cut lines, returned as faces.
 *
 * NOT a plain union. A cut endpoint is computed to land on the boundary and at
 * floating precision lands there only to within a few bits; union then
 * intermittently fails to node and the polygonizer silently returns fewer faces.
 * A rotated T-shape gave 1-4 faces depending on rotation, and nudging the cut
 * length changed the answer non-monotonically - the signature of a robustness
 * failure, not of geometry.
 *
 * The pre-reduction is the jsts-only half and is NOT optional. NTS drives
 * GeometryNoder with SnapRoundingNoder, which snaps EVERY vertex to the grid;
 * jsts still ships the legacy MCIndexSnapRounder, which snaps only the
 * intersections it computes and leaves original vertices where they were. Handed
 * the same near-miss shape that returns ZERO faces - not fewer, none - because
 * the boundary corners never reach the grid the new nodes landed on, so no ring
 * closes. Rounding every input through GeometryPrecisionReducer first puts those
 * vertices on the grid by hand, and the identical shape then yields its 2 faces. */
export function snap_round_polygonize(
	inputs: readonly JtsGeometry[],
	grid_scale: number
): JtsPolygon[]
{
	const precision = new PrecisionModel(grid_scale);

	const rounded: JtsGeometry[] = [];
	for (const geometry of inputs)
	{
		const reduced = GeometryPrecisionReducer.reduce(geometry, precision) as JtsGeometry;
		// Anything shorter than one grid cell reduces to an EMPTY LineString, and
		// GeometryNoder then reads coordinate [0] off it and dies four frames deep
		// with a bare "Cannot read properties of undefined". Dropping empties stops
		// one degenerate cut taking the whole analysis down.
		if (!reduced.isEmpty()) rounded.push(reduced);
	}
	if (rounded.length === 0) return [];

	const noded = new GeometryNoder(precision).node(java_list(rounded));

	// Polygonizer builds its graph on the first read and caches it: getPolygons()
	// on a reused instance returns the first call results no matter what was added
	// since, and reports no error. One per call, always.
	const polygonizer = new Polygonizer();
	for (const line of js_array<JtsGeometry>(noded)) polygonizer.add(line);

	return js_array<JtsPolygon>(polygonizer.getPolygons());
}

/** jsts has getNumInteriorRing/getInteriorRingN but no plural accessor. */
export function interior_rings(polygon: JtsPolygon): JtsGeometry[]
{
	const rings: JtsGeometry[] = [];
	for (let i = 0; i < polygon.getNumInteriorRing(); i++) rings.push(polygon.getInteriorRingN(i));
	return rings;
}

/** Several jsts entry points take java collections and reject a plain JS array
 * SILENTLY — setSites leaves the site list null and throws somewhere unrelated
 * later. Always hand them one of these. */
export function java_list<T>(items: readonly T[]): unknown
{
	// jsts's shipped declaration demands a constructor argument the runtime does
	// not; the no-arg form is the one that works.
	const List = ArrayList as unknown as new () => { add(item: T): void };
	const list = new List();
	for (const item of items) list.add(item);
	return list;
}

/** Strict interior test. This replaces NTS's PreparedGeometry, whose jsts port is
 * genuinely broken (prepare() throws on every geometry type — an unfixed
 * transpiler bug). IndexedPointInAreaLocator is the same index PreparedPolygon
 * uses internally, and matching INTERIOR exactly reproduces the C# behaviour
 * that a point on the boundary is NOT contained. */
export function interior_locator(polygon: JtsPolygon)
{
	const locator = new IndexedPointInAreaLocator(polygon);
	return (c: JtsCoordinate) => locator.locate(c) === Location.INTERIOR;
}

/** Indexed nearest-boundary distance. Plain geometry.distance() is O(nodes x
 * segments) — 10^6+ segment tests per analysis, which stalls the tab. */
export function boundary_distance(ring: JtsGeometry)
{
	const indexed = new IndexedFacetDistance(ring);
	return (c: JtsCoordinate) => indexed.distance(factory.createPoint(c)) as number;
}

/** Mitre-joined buffer.
 *
 * jsts has no geometry.buffer(distance, parameters) overload, and falling back to
 * the plain buffer silently gives ROUND joins — which reintroduces exactly the
 * seven false 4-21 sq ft corner regions the mitre join exists to remove. Built
 * with the no-arg constructor plus setters because the multi-argument
 * constructors fall through to defaults. */
export function mitre_buffer(geometry: JtsGeometry, distance: number, mitreLimit = 5.0): JtsGeometry
{
	const params = new BufferParameters();
	params.setJoinStyle(BufferParameters.JOIN_MITRE);
	params.setMitreLimit(mitreLimit);
	params.setEndCapStyle(BufferParameters.CAP_FLAT);
	return BufferOp.bufferOp(geometry, distance, params) as JtsGeometry;
}

/** Voronoi cells for a set of sites.
 *
 * The builder is one-shot — calling getDiagram twice returns the stale diagram
 * with no error — so a fresh one is constructed per call. The clip envelope is
 * deliberately left unset: clipping could cut cells inside the footprint, and the
 * containment filter downstream would then admit fake edges. */
/** Merge several paving rings into the one outline the pipeline measures.
 *
 * Needed because a drive is often drawn as several shapes. 29c0acaf_option_1
 * paints three of them #4D4D4D - 76,499, 28,089 and 19,986 drawing units - and
 * the colour tag keeps only the largest, so two thirds of the drive was invisible
 * until the user could say "these as well".
 *
 * A plain union is tried first and is usually not enough: those three pieces
 * share no vertex and stand 0.992 units apart, a hairline the drafter left
 * between abutting polygons. So when the union leaves more than one piece the
 * gap is MEASURED and closed by exactly that much - grow every piece by half the
 * gap so the faces meet, then shrink back by the same amount. The distance comes
 * off the drawing rather than from a constant, and `bridged_by` reports it so
 * the number is visible rather than buried.
 *
 * Returns null when the pieces are too far apart to be one surface, which is the
 * honest answer to selecting two unrelated drives. */
export function merge_rings(rings: readonly (readonly Pt[])[]): MergedRings | null
{
	if (rings.length === 0) return null;
	// Not rings.map(polygon_from_ring): map passes the index as a second argument,
	// which would land in the holes parameter.
	const polygons = rings.map((r) => polygon_from_ring(r));
	let merged = polygons.reduce((a, b) => a.union(b) as JtsPolygon);
	const pieces = merged.getNumGeometries();

	let bridged_by = 0;
	if (pieces > 1)
	{
		// Smallest hop that joins any two pieces. Growing by half of it from both
		// sides is exactly enough for their faces to touch.
		let gap = Infinity;
		for (let i = 0; i < pieces; i++)
		{
			for (let j = i + 1; j < pieces; j++)
			{
				const d = merged.getGeometryN(i).distance(merged.getGeometryN(j));
				if (d > 0 && d < gap) gap = d;
			}
		}
		if (!Number.isFinite(gap)) return null;
		bridged_by = gap;
		const reach = gap / 2 + gap * 1e-3;
		const closed = mitre_buffer(mitre_buffer(merged, reach), -reach) as JtsPolygon;
		if (closed.isEmpty() || closed.getNumGeometries() > 1) return null;
		merged = closed;
	}

	const to_pts = (g: JtsGeometry) => g.getCoordinates().map((c) => ({ x: c.x, y: c.y }));
	return {
		ring: to_pts(merged.getExteriorRing()),
		holes: interior_rings(merged).map(to_pts),
		pieces,
		bridged_by,
		area: merged.getArea(),
	};
}

export function voronoi_cells(sites: readonly JtsCoordinate[]): JtsPolygon[]
{
	const builder = new VoronoiDiagramBuilder();
	builder.setSites(java_list(sites));
	const diagram = builder.getDiagram(factory) as JtsGeometry;
	const cells: JtsPolygon[] = [];
	for (let i = 0; i < diagram.getNumGeometries(); i++)
	{
		const cell = diagram.getGeometryN(i);
		if (cell.getGeometryType() === "Polygon") cells.push(cell as JtsPolygon);
	}
	return cells;
}

/** jsts throws several unrelated error classes for the same numerical degeneracy
 * NTS reports as TopologyException, and none of them share a base class. Matching
 * on name survives minification, since each sets this.name explicitly. */
export function is_topology_failure(error: unknown): boolean
{
	const name = (error as { name?: string })?.name ?? "";
	return (
		name === "TopologyException" ||
		name === "LocateFailureException" ||
		name === "ConstraintEnforcementException"
	);
}
