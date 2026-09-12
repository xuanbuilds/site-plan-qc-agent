# Port Plan — C# / NetTopologySuite → TypeScript / jsts (browser)

Target repo: `C:\XY\prototype\260819_Site Plan QC Agent\driveway_check_web`
Proposed module root: `src/lib/identify/` (siblings to the existing `src/lib/paving.ts`, `src/lib/svg.ts`).

Three facts from the target repo that shape everything below:

- **jsts is not installed.** `package.json` has only react/clsx/lucide/tailwind-merge. TS is `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `moduleResolution: "bundler"`, `skipLibCheck: true`. That last one is already correct and is *required* — jsts's own `.d.ts` files fail internal variance checks without it. Do not turn it off.
- **The existing ingest produces faceted rings in SVG user units, with no arcs.** `src/lib/paving.ts` yields `Candidate.points: [number,number][]`, and `src/lib/svg.ts` yields `pxPerFt: number | null`. Every constant in the C# pipeline is in **feet**. Two consequences, both load-bearing, are handled as Step 1 and Step 10 below.
- **The golden fixtures do not exist as files.** `driveway_check_rhino/tests/` holds only three shapes and no rotation sweep; `HANDOFF.md` §6e says the 9-fixture synthetic suite "was built inline in `run_csharp` sessions and never landed — the 26/27 result cannot be reproduced." The 140/140 result is **14 Breps inside `driveway_checker.3dm` × 10 rotations (0/15/37/−20/60/90/123/−47/5/−75°)**. The only way to get those numbers into a TS test is to dump them out of Rhino. This is Step 0 and it must happen before any porting, because the .3dm is the single source and it is not under version control (§6f).

---

## 1. Dependency-ordered port sequence

### Step 0 — Extract the golden fixtures from Rhino (do this first, before any TS)

Not a port step; a data-rescue step. Use the Rhino MCP `run_csharp` tool against the open `driveway_checker.3dm` to write `driveway_check_web/fixtures/golden.json`. For each of the 14 Breps × each of the 10 rotation angles, dump:

```
{ brep, angleDeg,
  analysisWkt,        // post BrepToPolygon + MedianFinder.Bridge
  pavingWkt,          // real surface, median absent
  medianWkts[], medianAreas[],
  arcs: [{sx,sy,ex,ey,cx,cy,r}],          // BrepArcs.Extract output
  skeleton: { nodeCount, edgeCount, totalEdgeLength, branchCount, endpointCount },
  widthsSorted: [ ... ],                   // pruned profile values, ascending
  prune: { spursRemoved, survivingNodeCount },
  runs: [{avgWidth, length, category}],    // sorted by (category, length) to kill order-dependence
  aprons: [{mouthLen, midX, midY, outerWidth}],
  faceCategoriesMultiset: {DRIVE:n, LOT:n, APRON:n},
  laneAreaSum: number }
```

Why this shape: it lets you diff **every stage independently**, and it captures the WKT inputs so the TS side can be fed byte-identical geometry rather than re-deriving it. Also dump the three `SyntheticFootprints` shapes and rebuild the nine lost synthetic fixtures as WKT while you are in there (§6e says this is cheap and unblocks two other issues).

Also do a 1-hour **jsts spike** in the same sitting, before committing to the plan: confirm in a throwaway Vite entry that (a) `VoronoiDiagramBuilder.getDiagram` returns cells for ~500 boundary sites, (b) `noding/snapround/GeometryNoder.node()` runs and `Polygonizer` returns >1 face on a boundary + one cut line, (c) `IndexedPointInAreaLocator` and `IndexedFacetDistance` both construct. Those four are the only unknowns that could invalidate the architecture. Everything else is mechanical.

### Step 1 — `src/lib/identify/units.ts` + ingest adapter (no jsts)

Convert the existing `Candidate.points` from SVG user units to **feet** using `svg.pxPerFt`, at the pipeline boundary, once. Every downstream constant (`MouthTrim = 0.01`, the `1e-12` cross-product epsilon in ft², the `0.5` sq ft median floor, `run_tolerance = 3.0`, `sample_spacing = 2.0`, `SnapGridScale = 1e4` as a 0.0001 ft grid) assumes feet. Running the pipeline in user units silently invalidates six tuned constants at once and produces plausible-looking wrong answers.

Hard-fail (or run in a clearly-labelled "unscaled" mode) when `pxPerFt` is null. Do not scale the constants instead — one conversion at the boundary is auditable; six scaled constants are not.

**Testable output:** feet-space rings whose area matches `Candidate.area` × (1/pxPerFt)².

### Step 2 — `src/lib/identify/jts.ts` — the jsts facade (the only file that imports jsts)

```ts
import 'jsts/org/locationtech/jts/monkey.js'            // side effect: restores .buffer/.covers/.intersection/.isValid/…
export { default as Coordinate } from 'jsts/org/locationtech/jts/geom/Coordinate.js'
export { default as GeometryFactory } from 'jsts/org/locationtech/jts/geom/GeometryFactory.js'
// … Polygon, LineString, Envelope, PrecisionModel, TopologyException
export { default as BufferOp }        from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js'
export { default as BufferParameters }from 'jsts/org/locationtech/jts/operation/buffer/BufferParameters.js'
export { default as OverlayOp }       from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js'
export { default as RelateOp }        from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js'
export { default as VoronoiDiagramBuilder } from 'jsts/org/locationtech/jts/triangulate/VoronoiDiagramBuilder.js'
export { default as GeometryNoder }   from 'jsts/org/locationtech/jts/noding/snapround/GeometryNoder.js'
export { default as Polygonizer }     from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js'
export { default as IndexedPointInAreaLocator } from 'jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js'
export { default as IndexedFacetDistance }      from 'jsts/org/locationtech/jts/operation/distance/IndexedFacetDistance.js'
export { default as GeometryPrecisionReducer }  from 'jsts/org/locationtech/jts/precision/GeometryPrecisionReducer.js'
export { default as ArrayList }       from 'jsts/java/util/ArrayList.js'
export { default as Location }        from 'jsts/org/locationtech/jts/geom/Location.js'
```

Plus hand-written adapter helpers, because these are the traps that fail *silently*:

- `toJavaList(items)` / `fromJavaList(list)` — `VoronoiDiagramBuilder.setSites`, `GeometryNoder.node`, `Polygonizer.add`, `getPolygons()` all take/return java collections. A plain JS array is not rejected; it silently no-ops or throws far away.
- `interiorRings(poly)` — jsts has `getNumInteriorRing()` (singular) + `getInteriorRingN(i)`; there is no plural accessor.
- `bufferWith(geom, dist, params)` → `BufferOp.bufferOp(...)` — `geom.buffer(d, params)` has **no** BufferParameters overload.
- `isTopologyFailure(e)` → `['TopologyException','LocateFailureException','ConstraintEnforcementException'].includes(e.name)`.
- Hand-written TS interfaces for the ~15 members actually called. jsts's shipped types are `(...args:any[]): any` and `monkey.d.ts` is literally `export {}` — with `strict:true` you get zero safety and the compiler will not catch a single one of the traps above.

Add `"sideEffects": ["**/monkey.js"]` handling or an explicit re-export barrel so Rollup cannot tree-shake the monkey import out of the production build — the failure mode is "works in dev, `.covers is not a function` in `vite build`".

**Testable output:** a smoke test asserting `poly.covers(line)`, `poly.getArea()`, `BufferOp.bufferOp(sq, 1, mitreParams).getArea()` and `new IndexedPointInAreaLocator(poly).locate(c) === Location.INTERIOR` all work.

### Step 3 — `SkeletonGraph.ts` (no jsts, no deps) — **port this first**

Pure data structure. Nodes as `{x:number,y:number}[]` (do **not** use jsts `Coordinate` here — it buys nothing and costs you `any`). Immediately testable against hand-built graphs with exact integer assertions.

### Step 4 — `BoundaryArc.ts` (no jsts, no deps)

Trivial value object. Port `midpoint` as the **chord** midpoint literally.

### Step 5 — `WidthProfile.ts`, class only (no jsts yet)

`nodeWidth: Map<number, number>` plus a **strict accessor that throws on a miss**, plus `edgeWidth`. Leave `compute()` unimplemented (`throw`) until Step 8. `EdgeWidth` has zero call sites in the C# tree; port it for parity but expect `noUnusedLocals` friction — keep it exported.

### Step 6 — `SkeletonPruning.ts` (no jsts)

Depends on Steps 3+5 only. Testable with a hand-built spur graph and hand-assigned widths: assert `spursRemoved`, surviving node count, and edge set.

### Step 7 — `RunSegmenter.ts` and `Classifier.ts` (no jsts)

Both depend only on Steps 3+5. Fully unit-testable with synthetic graphs. Do these before touching any geometry library: they are ~40% of the pipeline's logic and 0% of its jsts risk.

At this point five of nine core files are ported and covered by fast unit tests with no dependency on jsts behaving.

### Step 8 — `WidthProfile.compute()` (first jsts contact, low risk)

`polygon.getExteriorRing()` + `IndexedFacetDistance` built **once per compute**, then `2.0 * ifd.distance(point)` per node. Verify `IndexedFacetDistance` exists in the installed build first (Step 0 spike); fallback is an STRtree of boundary segments. Do **not** substitute nearest-sampled-vertex distance — at 2 ft sampling that is up to ±1 ft of error and will move Classifier band decisions.

**Testable output:** feed the C# node coordinates from `golden.json` into `compute()` against the C# `analysisWkt`; the sorted width array must match to 1e-9 ft. This isolates jsts's distance code from the Voronoi divergence and is the cleanest single-stage proof in the whole plan.

### Step 9 — `MedianFinder.ts` (jsts buffer, independent of the skeleton)

Self-contained: polygon in, gap polygons out. Verify against `golden.json`'s `medianAreas` — the divided drive's median is documented as **227 sq ft, stable to the square foot at every rotation**, which is an exceptionally sharp acceptance target.

### Step 10 — `SkeletonExtractor.ts` (risky)

Voronoi + retry/jitter. Substitute `IndexedPointInAreaLocator` for `PreparedGeometry` (see §3). Memoize the containment result on the same quantized key used for node dedup — behaviour-preserving, and it removes tens of thousands of Point allocations per attempt, which is the browser hot spot.

### Step 11 — `ApronFinder.ts` (risky, and gated on arcs)

Blocked by an **ingest** decision, not a jsts one — see §3 item 12. Port the algorithm verbatim; feed it real arcs or feed it nothing.

### Step 12 — `RegionBuilder.ts` (highest jsts risk)

Snap-rounding noder + polygonizer + face tagging. Replace `Rhino.Geometry.Line` with `{from:{x,y}, to:{x,y}}` — that is the file's only Rhino coupling (line 3 `using Rhino.Geometry`, line 59 parameter, line 64 the four `.X/.Y` reads).

### Step 13 — `IdentifyRun.ts` orchestration + `SkeletonPreview` equivalent

Wire `MedianFinder → Bridge → SkeletonExtractor → WidthProfile → Pruning → RunSegmenter → Classifier → ApronFinder → RegionBuilder`. Note the C# feeds **the bridged `analysis` polygon** to the skeleton and width stages and **the real `paving`** to the lane intersection. Getting that backwards makes a median count as driveable surface.

---

## 2. Per-file difficulty and the single biggest hazard

| # | File | Difficulty | Single biggest hazard |
|---|---|---|---|
| 2 | `jts.ts` facade | **needs-thought** | Rollup tree-shakes the `monkey.js` side-effect import out of the production bundle → every predicate is `undefined` in `vite build` but fine in `vite dev`. |
| 3 | `SkeletonGraph.ts` | **trivial** | `buildAdjacency()` must pre-seed an entry for **every** index 0..N−1. A lazily-populated Map hands callers `undefined` for isolated nodes where C# returns an empty list. (Second: keep the `Degree()` vs `computeDegrees()` self-loop 1-vs-2 discrepancy literally; do not "fix" it.) |
| 4 | `BoundaryArc.ts` | **trivial** | `midpoint` is the **chord** midpoint, not the arc midpoint. It anchors the `R=` dimension label; "fixing" it silently moves every radius annotation. |
| 5 | `WidthProfile.ts` | **mechanical** | `Map.get(missing)` returns `undefined`, not a thrown `KeyNotFoundException`. `(undefined + x)/2` is NaN, and NaN propagates as a **silent no-op** through three downstream comparisons. The strict accessor is mandatory, not defensive styling. |
| 6 | `SkeletonPruning.ts` | **mechanical** | `[...map.keys()].sort()` sorts lexicographically (1,10,11,2…). `oldToNew` scrambles, every coordinate and width attaches to the wrong node, nothing throws. Must be `.sort((a,b)=>a-b)`. |
| 7a | `RunSegmenter.ts` | **needs-thought** | Latent infinite loop: the walk never consults `visitedEdges`, so a closed loop with no degree≠2 node circles forever and `run` grows unbounded. In Rhino that hangs; in a browser it freezes the tab unrecoverably. Add a hard cap of `graph.nodes.length` iterations plus a `curr === start` break. |
| 7b | `Classifier.ts` | **mechanical** | `Array.prototype.reverse()` mutates in place. A literal `a.reverse().concat(b.slice(1))` in `tryJoin` corrupts `result[i].nodeIndices`, which is the *same array instance* held by the caller's `runs` and by already-emitted `ClassifiedRun` records. Must be `[...a].reverse()`. |
| 8 | `WidthProfile.compute` | **needs-thought** | Performance: unindexed `boundary.distance(point)` is O(nodes × segments) ≈ 10⁶–10⁷ segment tests, run at least twice per analysis. Build `IndexedFacetDistance` once per compute or the browser stalls. |
| 9 | `MedianFinder.ts` | **needs-thought** | jsts has no `Geometry.buffer(dist, BufferParameters)` overload. Falling back to `geom.buffer(d)` silently gives **round** joins, which reintroduces exactly the seven false 4–21 sq ft corner regions the mitre join exists to eliminate. The bug presents as "phantom medians at every concave corner." |
| 10 | `SkeletonExtractor.ts` | **risky** | Node and edge **order** is the graph's identity, and it derives from the order `getDiagram()` returns cells, which is a site-ordering artifact that will not match NTS. The graph is geometrically correct and index-incompatible. Never write a test that asserts a node index across the C#/TS boundary. |
| 11 | `ApronFinder.ts` | **risky** | Input contract, not code: `BoundaryArc.Start/End` must be **true tangent points**. The current SVG ingest has no arcs at all. With re-fitted or faceted arcs, `MouthTrim = 0.01 ft` is no longer far below the fit error and the whole detector degrades silently to "no aprons found." |
| 12 | `RegionBuilder.ts` | **risky** | jsts's `GeometryNoder` uses the legacy `MCIndexSnapRounder`, not NTS's `SnapRoundingNoder`. It snaps only computed nodes to the grid and leaves original vertices off-grid, so the exact rotation-dependent face-count instability that `SnapGridScale` was introduced to cure can reappear in a new form. Mitigation: `GeometryPrecisionReducer` the boundary and the cut lines to the same 1e-4 grid **before** `node()`. |
| 13 | `IdentifyRun.ts` | **mechanical** | Feeding the raw paving (not the bridged analysis polygon) to the skeleton/width/apron stages. `MedianFinder`'s own comment records the median tip ending 0.002 ft from the apron mouth — on raw paving the mouth crosses 2.13 ft of grass and `SpansPaving` rejects the apron outright, with no error. |

---

## 3. Every jsts gap, with a concrete plan

| # | Gap | Plan |
|---|---|---|
| 1 | **No package entry point.** jsts 2.12.1 has no `main`/`module`/`exports` and no root `index.js`. `import 'jsts'` fails outright. | **Substitute:** deep ESM imports with mandatory `.js` extensions, all confined to `jts.ts`. Never import `dist/jsts.min.js` — mixing it with deep imports gives two class identities and every `instanceof` silently returns false. |
| 2 | **Geometry shortcut methods stripped** (`.buffer`, `.covers`, `.contains`, `.intersection`, `.difference`, `.isValid`, `.distance`, `.toString`). | **Substitute:** one side-effect `import 'jsts/org/locationtech/jts/monkey.js'` at the top of `jts.ts`, *plus* use the op classes directly for the four operations that need them anyway (`BufferOp` for params, `OverlayOp` for difference/intersection, `RelateOp.covers`). Belt and braces, because monkey methods are untyped and TS will reject `poly.covers(x)` even when it works at runtime. |
| 3 | **TypeScript declarations are `any` or absent**; `monkey.d.ts` is `export {}`. | **Hand-implement:** a ~60-line typed facade interface in `jts.ts` covering only the members used. This is where all C#-side type safety goes to die otherwise. |
| 4 | **`PreparedGeometryFactory.prepare()` throws** on Point/LineString/Polygon (a real, unfixed transpiler bug; upstream issue #479 closed for inactivity). Also absent from the dist bundle entirely. | **Substitute, do not patch.** Use `IndexedPointInAreaLocator` — it is the exact index `PreparedPolygon` uses internally, works today, takes a `Coordinate` (no Point allocation), and benchmarks within ~15% of the prepared path and ~14× faster than plain `contains`. Semantic mapping: NTS `prepared.Contains(point)` ⇔ `locate(c) === Location.INTERIOR` (strict — BOUNDARY is *not* contained, which is exactly the load-bearing behaviour in both `SkeletonExtractor` and `RegionBuilder`). Do **not** ship the `constructor_` monkey patch that un-breaks the prep package; it patches library internals against an abandoned bug. |
| 5 | **`Geometry.Buffer(dist, BufferParameters)` overload missing.** | **Substitute:** `BufferOp.bufferOp(geom, dist, params)`. |
| 6 | **`BufferParameters` object-initializer and enums missing.** | **Substitute:** setters, not properties: `setJoinStyle(BufferParameters.JOIN_MITRE)`, `setMitreLimit(5.0)`, `setEndCapStyle(BufferParameters.CAP_FLAT)`. Integer values match NTS (`Mitre=2`, `Flat=2`) so persisted ints port unchanged. **Ordering trap:** `setQuadrantSegments()` resets to 8 whenever joinStyle ≠ ROUND, and a 3-arg constructor silently falls through to all-defaults. Use the no-arg ctor + setters, quadrant segments last. |
| 7 | **`Polygon.InteriorRings` plural accessor missing.** | **Hand-implement:** 3-line `interiorRings(p)` helper in `jts.ts`. |
| 8 | **C# exception filter `catch (TopologyException) when (attempt < max-1)` has no JS form.** Also jsts's triangulate package throws `LocateFailureException` / `ConstraintEnforcementException`, neither a TopologyException subclass. | **Hand-implement:** try/catch every error; on the final attempt, rethrow. Match on `e.name` (survives minification — the class sets `this.name` explicitly) rather than `instanceof`. Never catch-all-and-return-empty: the C# deliberately lets the last failure propagate, and a silent empty skeleton reads downstream as "this footprint has no medial axis." |
| 9 | **No OverlayNG.** jsts ships only the legacy `OverlayOp`. | **Accept, with mitigation.** Verified: the C# side never sets `NtsGeometryServices`/`GeometryOverlay`, and NTS still defaults to `GeometryOverlay.Legacy` — so this is legacy-vs-legacy, not NG-vs-legacy. The residual gap is ~3 JTS releases of robustness fixes. Mitigation: `GeometryPrecisionReducer` pre-pass on overlay operands, wrapped in try/catch with one reduced-precision retry. Do not attempt to hand-port OverlayNG. |
| 10 | **`GeometryNoder` uses the old `MCIndexSnapRounder`**, so output vertices are not all on the grid (NTS's `SnapRoundingNoder` puts every output vertex on-grid). | **Substitute + compensate:** pre-round the analysis boundary and every cut line through `GeometryPrecisionReducer` at the same `PrecisionModel(1e4)` **before** calling `node()`; the old `GeometryNoder` javadoc assumes pre-rounded input. Keep `setValidate(true)` on through development so `NodingValidator` surfaces non-noded output loudly. This is the single most likely source of rotation-dependent face-count drift — treat it as the acceptance gate for Step 12. |
| 11 | **jsts collection APIs take/return java collections, not JS arrays**, and fail *silently*: `Polygonizer.add(array)` is a no-op returning zero polygons; `VoronoiDiagramBuilder.setSites(array)` leaves `_siteCoords` null and throws a useless `null.iterator` later; `UnaryUnionOp.union(array)` returns `undefined`. | **Hand-implement:** `toJavaList`/`fromJavaList` adapters. For Voronoi specifically, prefer `gf.createMultiPointFromCoords(coords)` (a Geometry) over an ArrayList. |
| 12 | **No true arcs in the browser ingest.** Not a jsts gap — a data gap, and the largest functional one. `BoundaryArc` comes from `BrepArcs.Extract(Brep)` in Rhino; `src/lib/paving.ts` produces flat point arrays. | **Hand-implement, with an explicit drop path.** Preferred: preserve arcs during SVG `path` parsing — an `A` command carries `rx,ry,rotation,large-arc,sweep` plus endpoints, and the standard endpoint-to-center conversion gives exact `center`/`radius`; the endpoints *are* the tangent points when the drafter drew tangent fillets. ~60 lines, exact. **Fallback if the source SVG is already tessellated (no `A` commands): drop APRON detection and say so in the UI.** Do not circle-fit runs of vertices — `MouthTrim = 0.01 ft` is far below any real dimension but *not* below a fit error, so a fitted-arc apron detector produces confident wrong answers. Report "apron detection unavailable for this plan" rather than silently returning zero aprons. |
| 13 | **`new Random(12345)` stream is not reproducible in JS.** | **Substitute:** `mulberry32(12345)`. Construct once **outside** the retry loop (state carries across attempts — do not re-seed per attempt); draw X before Y per point; jitter magnitude from the *original* `sampleSpacing`, not the attempt-scaled one. Accept that inputs needing attempt ≥ 1 will not be bit-identical to C#. |
| 14 | **`Math.Round` is banker's rounding; JS `Math.round` is half-up and asymmetric for negatives.** | **Hand-implement:** a `roundHalfToEven` helper for `Quantize`. At 1e-6 precision an exact tie is vanishingly rare, but it costs 6 lines and removes a class of "differs only on some rotations" bugs. |
| 15 | **`Array.BinarySearch` semantics** (exact hit → that index; miss → `~insertionIndex`). | **Hand-implement** in `SkeletonExtractor.pointAtLength`. Then `clamp(i, 1, coords.length-1)`. A plain `lower_bound` differs on duplicate cumulative values, though the 1e-12 guard makes the resulting point identical in practice. |
| 16 | **Value-type tuple keys** (`Dictionary<(long,long),int>`, `HashSet<(int,int)>`, `HashSet<(int,int)>` in RunSegmenter). JS `Set`/`Map` key by reference. | **Hand-implement:** string keys `` `${qx},${qy}` `` and `` `${min},${max}` ``. Getting this wrong disables node dedup entirely — the node count explodes, no vertices are shared, all degrees are 1, `branchNodes()` is empty, and nothing throws. |
| 17 | **`Dictionary[k]` throws loudly; `Map.get(k)` returns `undefined` silently.** | **Hand-implement:** strict accessors on `WidthProfile.nodeWidth` and on adjacency. This affects `SkeletonPruning` (silently prunes nothing), `RunSegmenter` (silently never splits), `Classifier` (silently returns Lot), and `ApronFinder` (silently "not a throat"). All four failure modes look like a working pipeline. |
| 18 | **`Rhino.Geometry.Line` in `RegionBuilder`.** | **Substitute:** `{from:{x,y}, to:{x,y}}`. Mechanical; nothing else in the file is Rhino-aware. Also filter zero-length lines before the noder — the C# relies on `SkeletonPreview` having done it upstream. |
| 19 | **`Polygonizer` is one-shot** (results cached; later `add()` calls silently ignored); `VoronoiDiagramBuilder` likewise (`create()` short-circuits on `_subdiv !== null`). | **Accept, document:** construct a fresh instance per computation. Reusing a builder returns a stale diagram with no error. |
| 20 | **Voronoi cell count ≠ site count and cell order ≠ input order**; a single site returns zero cells. | **Accept:** the C# already re-derives everything from cell ring vertices and never index-matches. Add an explicit `n < 2` guard. Leave `setClipEnvelope` **unset** — setting it could clip cells *inside* the footprint and the containment filter would start admitting fake edges. |
| 21 | **C# `record` value equality / `with` / `Deconstruct`** on `BoundaryArc`, `ClassifiedRun`, `Apron`, `PruneResult`, `IdentifiedRegion`. | **Drop.** No call site in the C# tree depends on record equality (no `Distinct`, no `HashSet<Apron>`). Use plain TS interfaces and keep them reference-unique. Explicitly do **not** add structural dedup that the original does not perform — `ApronFinder.Find` can legitimately return two Aprons for one physical flare and downstream masks it. |
| 22 | **Dead code:** `WidthProfile.EdgeWidth` (zero call sites) and `Classifier.Classify` (byte-identical duplicate of the `ClassifyRuns` loop body). | **`EdgeWidth`: port for parity, keep exported.** **`Classify`: drop it**, or better, hoist it into the single shared scoring helper `ClassifyRuns` should have been calling. Porting both copies guarantees drift. Note `noUnusedLocals: true` will surface either mistake at build time. |

---

## 4. Constants: verbatim vs. re-derivable

### Carry across VERBATIM — empirically derived, evidence recorded

| Constant | Value | Evidence that pins it |
|---|---|---|
| `SkeletonPruning.tipConvergenceRatio` | **0.5** | Every genuine corner-ear artifact measured ≤ **0.30**; the lowest genuine structural connection ≈ **1.0**. 0.5 sits mid-gap. Setting it to exactly 0.3 left a visible stray sliver. Keep the comparison **strict `<`** — the 0.3 anecdote *is* the boundary case. |
| `ApronFinder.ThroatWidthRatio` | **1.15** | Real apron mouth measured **1.04×** local width (stable across two rotations, asymmetric fillets r=7.27/r=13.76); nearest false mouth **1.28×**, others 1.55/1.95/2.09. Do **not** tighten toward 1.04. Do **not** add the perpendicularity test that was measured and rejected (real 79°/73° vs false 79°/76° — the ranges overlap outright). |
| `ApronFinder.MouthTrim` | **0.01 ft** | Testing the full-length mouth made aprons vanish on rotated footprints while the unrotated twin was found. This is a rotation-stability fix, not a tolerance. |
| `ApronFinder` depth limit (implicit ×1.0 on `OuterWidth`) and lateral gate (÷2.0) | 1.0, 0.5 | Measured: throat 15 ft, flare opening 90 ft, depth 40 ft → 40 < 90 passes, false mouths run far deeper than the paving is wide. |
| `MedianFinder` **mitre** join + `MitreLimit` **5.0** | JOIN_MITRE, 5.0 | Round joins produced **seven false regions of 4–21 sq ft** at concave corners across the fixtures; mitre produced none, with the one real median stable at **227 sq ft to the square foot across 14 footprints × 8 rotations**. (5.0 is also the JTS/NTS default, so setting it is defensive — set it anyway, explicitly.) |
| `MedianFinder` gap area floor | **0.5 sq ft** | Documented as a *numerical noise floor*, explicitly **not** a judgement about how small a median can be. **If jsts's legacy buffer leaves larger slivers, do not raise this** — fix the input precision instead. Raising it starts silently discarding real geometry. |
| `Classifier.DriveAspectRatio` | **2.5** | Self-described as a placeholder, but empirically *constrained*: a genuine merged Lot measured **73 ft / 28 ft = 2.6**, i.e. 0.1 of slack above the cutoff. Treat as having **zero** margin. Carry verbatim and do not re-tune until after the skeleton stage is validated (see §6 risk 2). |
| `SkeletonPruning.lengthToWidthRatio` | **0.75** | Magnitude undocumented, but it is one half of a two-test rule whose other half (0.5) *is* calibrated. Changing it changes which spurs the calibrated test ever sees. Carry verbatim. |
| `SkeletonExtractor` min samples/ring | **8** | Inherited verbatim from the Python prototype's `_sample_boundary`. Changes site count → changes the whole diagram. |
| `sample_spacing` / `run_tolerance` | **2.0 ft / 3.0 ft** | Not justified in-file, but they set skeleton node **density**, and both `Classifier.avg_width` (unweighted mean over nodes) and `RunLength` (chord sum) depend on density. Changing either invalidates the 2.5 threshold. |
| Retry machinery: `maxAttempts` **12**, spacing growth **1.0123**, jitter **`sampleSpacing × 1e-4`**, seed **12345** | as-is | 5→12 was raised together with adding jitter. Pure spacing scaling was measured to fail on every attempt up to +5% on a real T-shape, because uniform scaling preserves symmetric coincidences; per-point jitter breaks them. Verified harmless: staple 256→258 nodes, strip+pad identical at 59. **Do not "clean these up" on the assumption jsts is better behaved — it is worse behaved.** |
| Structural degree thresholds | 1 / 2 / ≥3 | Definitional, not tuned, but they are what the snapshot rule in `Prune` protects. |

### Safe to re-derive or re-validate against jsts

| Constant | Value | Why it is safe to move |
|---|---|---|
| `RegionBuilder.SnapGridScale` | **1e4** | Explicitly documented as producing **identical results across 1e2..1e6** (0.01 ft to 1e-6 ft grids) — "the exact scale is not a tuned magic number." **This is the one dial you are permitted to turn** if jsts's `MCIndexSnapRounder` misbehaves. Re-validate by sweeping it and confirming face count is rotation-invariant, exactly as the C# author did. |
| `SkeletonExtractor.Quantize` precision | **1e-6** | Undocumented; it is the tolerance at which two Voronoi cell-ring vertices fuse into one node. jsts's vertex coincidence may differ. Safe to widen slightly, provided it stays orders of magnitude below any real dimension. Validate via the node/edge counts in `golden.json`. |
| `PointAtLength` degenerate-segment epsilon | **1e-12** | Structural divide-by-zero guard. |
| `ApronFinder.CrossingParameter` denominator epsilon | **1e-12** | Structural parallel/collinear guard — **but note it is a 2D cross product with units of ft², not dimensionless.** If Step 1's unit conversion is ever skipped or the pipeline runs in metres, this must be rescaled or it will accept parallel spine edges as crossings. |
| `MedianFinder.reach` | `Area / Length` | Derived, not fitted: area/perimeter is half the width of an elongated region. Do not replace with a literal. |
| `WidthProfile` diameter factor **2.0**; `EdgeWidth` divisor **2.0**; `path.Take(count-1)`; `old < nbr` dedupe | — | Exact geometry / exact arithmetic. Not tuned, cannot drift. |
| Reason-string formats `F0` / `F1` | — | Display only. `.toFixed()` differs from C# `F0`/`F1` at exact midpoints and C# `F` is culture-dependent. Never assert on these strings; rebuild them from numeric fields in any test. |

---

## 5. Verification strategy

The C# baseline is **140/140 = 14 Breps × 10 rotations (0/15/37/−20/60/90/123/−47/5/−75°)**, and `HANDOFF.md` is explicit that **tag order varies with rotation (polygonizer face order) but the multiset does not — "don't read anything into the ordering."** That sentence defines the acceptance criterion.

### What to compare — and equally, what NOT to compare

**Never compare across the C#/TS boundary:** node indices, edge order, run order, `ClassifiedRun` output order (merged runs are appended to the end), polygonizer face order, or reason strings. All of these are legitimately implementation-defined and all of them will differ.

### Tier 0 — pure-logic unit tests (Steps 3–7, no jsts, no fixtures)

Hand-built graphs, exact assertions. Must include the specific regressions the C# comments record:

- **Sibling ears**: two spurs on one branch node must *both* prune in a single pass (the snapshot rule). A mutate-as-you-go implementation passes every other test and fails this one.
- **Compact pad**: a short stub into a 20×20 pad must **not** prune (tip width test).
- **Bare path component**: a two-leaf path must never delete itself.
- **Isolated node**: degree-0 survives into the output with zero edges; is seeded by `RunSegmenter` but emits no run.
- **Closed loop**: `RunSegmenter` on a ring with no degree≠2 node must terminate (guards the tab-freeze).
- **Run overlap contract**: consecutive split runs share their junction node; `tryJoin` must not mutate its inputs (assert the source arrays are unchanged after a merge).
- **Merge does not reclassify**: three Lot slices + one Drive must not collapse to a single Drive.

### Tier 1 — stage-isolated comparison against `golden.json`

Feed the TS stage the **C# input** (from `golden.json`), so each stage is tested without inheriting the previous stage's divergence.

| Stage | Input injected | Compared | Tolerance |
|---|---|---|---|
| MedianFinder | `analysisWkt` precursor / raw paving WKT | gap count; each gap area | **±1.0 sq ft** (C# reports 227 sq ft "stable to the square foot") |
| WidthProfile | C# node coords + `analysisWkt` | sorted width array, elementwise | **1e-9 ft** — this is a pure DistanceOp comparison and should be near-exact |
| SkeletonPruning | C# graph + C# widths | `spursRemoved`, surviving node count, edge set | **exact** |
| RunSegmenter | C# pruned graph + widths | run count; each run's node-count | **exact** |
| Classifier | same | run count; sorted `(category, length, avgWidth)` tuples | length/width **1e-9**, category **exact** |
| ApronFinder | C# graph + widths + C# arcs | apron count; mouth length; mouth midpoint | count **exact**; length and midpoint **±0.05 ft** |
| SkeletonExtractor | `analysisWkt` only | node count, edge count, `totalEdgeLength`, branch count, endpoint count | totalEdgeLength **±2%**; node/edge count **±5%**; **branch and endpoint counts exact** |
| RegionBuilder | `analysisWkt` + `pavingWkt` + C# cut lines | face count; category multiset; lane area sum | face count **exact**; multiset **exact**; area sum **±0.5 sq ft** |

The skeleton row is the only one with a loose tolerance, and deliberately so: jitter and attempt-count differences legitimately change node count (C# itself measured 256→258 for one shape). Branch/endpoint counts must still be exact — those are topology, and topology is what everything downstream reads.

### Tier 2 — end-to-end, the 140-case gate

For each of the 14 Breps × 10 rotations, run the full TS pipeline on `analysisWkt`/`pavingWkt`/`arcs` and assert:

1. **Category multiset equals the C# multiset, exactly.** E.g. `d7d872ca` → `{DRIVE:3, LOT:1}` with **no APRON**; `6d72bcf8` and `169c4681` → `{DRIVE:1, APRON:1}`; `b02eaf59` (divided) → `{DRIVE:1, APRON:1}`, identical to its two undivided twins. **This is the pass/fail gate: 140/140.**
2. **Lane area *sum* per region within ±0.5 sq ft.** Explicitly **do not** assert lane *count* — §6d-3 documents that the divided drive's two lanes merge into one piece on 3 of 10 rotations in the C# itself (921 + 896 = 1817 sq ft either way). Any TS test asserting "2 lanes" fails against correct behaviour.
3. **Apron mouth length within ±0.05 ft** where an apron is expected (the `169c4681`/`6d72bcf8` pair share an 18.92 ft mouth and identical fillets — a free arc-driven rotation check).

### Tier 3 — rotation-stability self-check (no C# needed, and the strongest signal)

For each shape, run all 10 rotations **in TS only** and assert the category multiset is identical across all 10. This catches the failure mode the C# author hit repeatedly — noding robustness — without needing Rhino in the loop, and it is the check to run on every commit. Add the same sweep to CI over the rebuilt synthetic fixtures (staple, flared drive, filleted staple, square, thin strip, L drive+pad, T-notch+wing).

Add the author's own robustness heuristic as an explicit assertion: **nudge the cut length by 0.001 / 0.01 / 0.1 / 1.0 ft and require the face count not to change.** The C# recorded 3/2/3/4 faces under exactly that nudge before snap-rounding was introduced — non-monotonic response to a tiny geometric nudge is the signature of a noding failure, and it is a cheap automated tripwire for Step 12.

### Tier 4 — fuzz

Random unions of 2–5 axis-aligned rectangles, rotated at random angles. Assert: no uncaught exception; no run exceeding the iteration cap; the multiset is rotation-stable; total runtime under a browser budget (target < 2 s for a typical footprint — the retry loop can repeat the Voronoi + containment pass 12 times).

---

## 6. Honest risks — what is most likely to silently differ

Ranked by (likelihood × how quietly it fails).

**1. Node density shifts the aspect ratio past 2.5.** *(highest)* `Classifier.avg_width` is an **unweighted mean over nodes** and `RunLength` is a **chord sum** — both are functions of how densely the skeleton is sampled. jsts's Voronoi will not produce the same node distribution as NTS's. A real Lot was measured at **2.6** against a **2.5** cutoff: 4% of slack. A 4% shift in either numerator or denominator flips a Lot to a Drive, the merge cascade then swallows the neighbouring drive, and an entire L-shaped footprint reports as a single DRIVE with the lot lost. Nothing throws; the output is a confident, plausible, wrong label. **Mitigation:** the Tier-1 skeleton row (totalEdgeLength ±2%, branch/endpoint exact) exists specifically to catch this before it reaches the classifier, and the 90 ft-pad and 60 ft-pad cases named in the `Merged()` comment must be in the fixture set.

**2. A missing map key becomes NaN and disables a whole stage.** Four independent sites (`SkeletonPruning`, `RunSegmenter`, `Classifier`, `ApronFinder`). Every one of them fails *open*: `x < NaN` is false, so pruning prunes nothing (the documented "21 runs" failure), the segmenter never splits, the classifier returns Lot, and the apron detector returns "not a throat." The C# throws `KeyNotFoundException` at all four. This is the difference that most resembles working software. Strict accessors are the entire mitigation and they are non-negotiable.

**3. Round buffer joins instead of mitre in `MedianFinder`.** If anyone writes `geom.buffer(reach)` because the params overload does not exist, you get seven phantom medians of 4–21 sq ft at every concave corner, they get bridged into the analysis polygon, and the skeleton, widths, runs and apron search all run on a subtly wrong shape. No exception anywhere.

**4. Snap-rounding divergence in `RegionBuilder`.** jsts's `MCIndexSnapRounder` leaves original vertices off-grid where NTS's `SnapRoundingNoder` snaps everything. `Contains` is strict, probe points (`apron.Inside`, skeleton nodes) are never snapped, and the near-degenerate "probe exactly on a face edge" case is currently resolved by an *accident* of the offset between snapped faces and unsnapped probes. Any change to the grid, to probe-coordinate provenance, or to jsts's rounding tie-breaks can flip a face's category or drop it entirely via the `continue`. Presents as "at −20° the flare face vanishes and goes untagged" — which is precisely the bug the C# already fixed once.

**5. APRON silently never fires.** The most likely *feature-level* regression. It depends on true arc tangent points that the current ingest does not carry. `ApronFinder.Find` returns an empty list for missing arcs with no error, `RegionBuilder` then never tags a face APRON, and `b02eaf59`/`6d72bcf8`/`169c4681` come back as plain DRIVE. Nothing in the pipeline distinguishes "no aprons here" from "no arc data supplied." **Mitigation:** make `arcs === null` a distinct, surfaced state — "apron detection unavailable" — not an empty array.

**6. Ordering differences that are correct but break naive tests.** Voronoi cell order → node/edge order → adjacency order → `nexts[0]` → run emission order → `runs.FirstOrDefault` face ownership → polygonizer face order. Each link is legitimately implementation-defined; together they mean any test asserting an index, an order, or a "first" anything will fail against a correct port. Worse, `RegionBuilder`'s primary rule (`runs.FirstOrDefault`) and fallback (stable `OrderByDescending`) *do* resolve ties by list order deliberately, so ordering is not purely cosmetic — it can change a face's category when a face holds several runs. Write the fallback as an explicit stable max-scan with strict `>`, never as a comparator sort.

**7. Legacy overlay throwing where NTS did not.** jsts trails NTS by ~3 JTS releases of legacy-overlay robustness fixes, and `RegionBuilder`'s `face.intersection(paving)` is exactly the shape that provokes it — the faces are polygonized *from* the paving boundary, so their edges are coincident with it by construction. This one at least fails loudly.

**8. The jitter path.** Any footprint that needs attempt ≥ 1 will not be bit-identical to C#, because `.NET Random(12345)` is unreproducible. Accept it; make the TS side self-deterministic with `mulberry32(12345)` and expect the *set of shapes that trip the retry* to be different in jsts, not merely the results. Do not treat a fixture that needs retries in one implementation and not the other as a failure.

**9. Two low-effort, high-blast-radius JS-specific bugs.** Lexicographic `.sort()` in `SkeletonPruning` (scrambles every coordinate and width, throws nothing) and in-place `Array.reverse()` in `Classifier.tryJoin` (corrupts arrays shared with the caller and with already-emitted records). Both are one-line fixes and both produce geometrically wrong, exception-free output. Put an explicit unit test on each.

**10. Unit mismatch.** Six absolute constants assume feet. The web ingest is in SVG user units and `pxPerFt` can be null. Handled by Step 1, but if that boundary is ever bypassed the pipeline still runs and still returns labels — just calibrated to a scale that does not exist.

**11. The tab freezing.** `RunSegmenter`'s walk never consults `visitedEdges`, and a ring-shaped paved footprint (loop drive around an island) with no degree≠2 node loops forever. `MedianFinder.Bridge` usually breaks such a loop first, which is why it has never fired in Rhino — where the consequence would have been a hang, not an unrecoverable browser tab. Add the guard even though the C# does not have one; this is the one place where deliberately diverging from the original is correct.