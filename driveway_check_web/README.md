# Driveway Checker — web prototype

Part 2/2 of the Driveway Checker. The Rhino prototype lives in
`../driveway_check_rhino`.

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and drop `samples/option_1.svg` on it.

## What it does today

**Open an SVG, report what the file declares, and let you look at it properly.**

- Drop or choose an `.svg`. It is read in the browser — nothing is uploaded.
- Scroll wheel zooms toward the cursor; drag to pan; the toolbar has fit and
  step-zoom. Vectors stay sharp at any zoom, so a 9 ft stall is legible.
- The view is contained: fit-to-page is the minimum zoom, and panning stops at
  the drawing's own edges, so the plan can never be dragged off into blank space.
- A panel reports paper size, `viewBox`, **scale**, site extent in feet, and an
  element census.

It identifies the paved surface (see below). It does **not** measure or check anything yet.

## What the real export turned out to contain

`samples/option_1.svg` is a Cedar export and is the reference case. Its metadata
inventory, in full:

| Attribute | Count | Useful? |
|---|---|---|
| `data-px-per-ft="2.788028"` on the root | 1 | **Yes — this is the drawing scale** |
| `data-mesh-name` on `<g>` | 132 | No. UUIDs, not semantic names |
| `fill` | 6 distinct values | Partly — see below |
| `id`, `class`, `<title>`, `<desc>`, `<metadata>` | 0 | — |

Two consequences:

**Scale is solved for Cedar exports.** `data-px-per-ft` converts every distance
to feet directly, so the panel shows a real site extent (688.66 x 387.37 ft)
rather than `cannot determine`. It is read explicitly, never inferred.

**The paving is one path.** `fill="#4D4D4D"` appears exactly once in the file: a
single closed ring, 1,987 vertices, already tessellated to straight segments —
9,525 sq ft, 985 ft perimeter, mean width about 19.3 ft. That is precisely the
input shape Part 1 expects.

> ⚠ That colour match is a **convention of one exporter observed in one file**,
> not a general rule. It is a shortcut worth taking only if the exporter is made
> to guarantee it — see below.

## The upstream ask

Cedar controls this exporter, so the identification problem does not have to be
solved by inference. One attribute per meaningful path — `data-role="paving"`,
`data-role="stall"`, `data-role="lot-line"` — removes the hardest half of the
work for Cedar's own plans, and is far more robust than matching a hex colour
that a palette change would silently break.

Third-party SVGs still need the hard path: no scale, no roles, geometry only.

## Design

Tokens are lifted verbatim from `cedar-build/styles/tailwind.css` into
`src/index.css`, and the Roobert variable font is copied into `public/fonts`.
React 19 + TypeScript + Tailwind v4 + lucide — cedar-build's idiom minus
Next.js — so components move across without a restyle.

Light theme only for now; `index.html` pins `class="light"`. The `.dark` token
block is already present if that changes.

## Notes for the next step

- `src/lib/svg.ts` inlines the markup rather than using an `<img>` blob, so a
  later step can hit-test and tag individual elements. `sanitize()` strips
  `script`, `foreignObject`, `on*` handlers and `javascript:` hrefs first.
- **Manual scale calibration** (draw a line, type its true length) is still
  needed, but as a *fallback* for files without `data-px-per-ft` — not as the
  primary path.
- Zoom is a CSS transform on a wrapper, not an SVG `viewBox` rewrite. Cheap, and
  it keeps the SVG's own coordinate system intact for later hit-testing.

## Paving detection

`src/lib/paving.ts`. Two approaches, converging on the same confirm step.

**Approach 1 — pre-tagged.** `data-role="paving"`, or cedarOS's `fill="#4D4D4D"`
(set by `POLYLINE_STYLES.drive` in its exporter, so a guarantee for that source).
Pre-selects only; a missing or changed tag costs a click, not the result.

**Approach 2 — shape ranking.** No metadata, any SVG.

1. keep filled closed paths — 6,978 → 141 on `option_1.svg`
2. `fill_ratio` = area ÷ bounding-box area
3. rank by `area ÷ fill_ratio` — circulation is large but sparse in its own box;
   buildings are compact and fill theirs

Measured on `option_1.svg` with the cedar fill stripped out, so approach 1 could
not fire: **rank 1 of 141, 3.0× margin over second place**, same region as the
tagged path — 9,525 sf, 985 ft perimeter, 19.3 ft mean width, 1,987 vertices.
Its `fill_ratio` is 0.140; every other region falls between 0.29 and 0.52.

**Neither approach auto-confirms.** The panel says "proposed, not confirmed"
until a human clicks. Clicking any region on the plan overrides the pick — that
is what makes ranking safe to ship, and it is not optional.

> ⚠ 0.140 vs 0.29 is one file. The code **ranks**; do not turn it into a
> threshold without a lot more plans behind it.

### Site envelope — why off-site regions are inert

Context (neighbouring parcels, streets, adjacent buildings) is drawn on the same
sheet and is just as clickable as the site. A region only becomes selectable if
its centroid lies within **2x the paving's own mean width** of the paving polygon.

Measured on `option_1.svg`, distance from the paving polygon:

| | count | min | median | max |
|---|---|---|---|---|
| units, garages, paving | 133 | 11.9 ft | 29.6 ft | **31.4 ft** |
| context buildings | 8 | **53.1 ft** | 112.4 ft | 213.7 ft |

Site content tops out at 1.6x mean width; context starts at 2.8x. The cut sits
at 2x — expressed against the drive rather than in feet, so it scales with the
plan instead of being tuned to this one.

The **site boundary is not usable for this**. The dash-dot property line in this
export is only two unique 2-point segments, not a closed ring, so it encloses
nothing. Distance-to-paving was the fallback, and it separates cleanly.

> ⚠ Axis-aligned bounding boxes do **not** work here — the site sits at ~45deg,
> so its bbox swallows nearby context. Distance to the polygon respects rotation.

### Interaction

- **nothing selected** — the drawing renders untouched
- **selected** — everything else drops to 12% opacity, the region goes amber, and
  a callout appears at the region's **area centroid** (tracked through pan/zoom
  via `getScreenCTM`, not a bounding-box centre)
- clicking the region confirms it; clicking empty space clears back to the
  original drawing; clicking off-site does nothing at all

## Part 1 port — feature identification

`src/lib/identify/` ports the Rhino C# pipeline to TypeScript on **jsts** (the
JavaScript port of JTS, which NetTopologySuite is itself a .NET port of, so the
geometry calls map across nearly name for name).

| Module | jsts? | From |
|---|---|---|
| `skeleton-graph.ts` | no | `Core/SkeletonGraph.cs` |
| `width-profile.ts` | no | `Core/WidthProfile.cs` |
| `skeleton-pruning.ts` | no | `Core/SkeletonPruning.cs` |
| `run-segmenter.ts` | no | `Core/RunSegmenter.cs` |
| `classifier.ts` | no | `Core/Classifier.cs` |
| `jts.ts` | **yes — the only one** | — |
| `skeleton-extractor.ts` | via facade | `Core/SkeletonExtractor.cs` |
| `median-finder.ts` | via facade | `Core/MedianFinder.cs` |
| `index.ts` | — | `IdentifyRun.cs` |

Not yet ported: `ApronFinder` (needs true arc tangent points, which the SVG
ingest does not carry) and `RegionBuilder` (cuts the footprint into labelled
faces).

### Divergences from the C#, all deliberate

- **`PreparedGeometry` → `IndexedPointInAreaLocator`.** jsts's `prepare()` throws
  on every geometry type — an unfixed transpiler bug. The locator is the same
  index `PreparedPolygon` uses internally, and `=== INTERIOR` reproduces the C#
  behaviour that a point on the boundary is *not* contained.
- **`WidthProfile.at()` throws on a miss.** The C# indexes a Dictionary, which
  throws; a `Map` returns `undefined`, `(undefined+x)/2` is `NaN`, and every
  comparison against `NaN` is false — so pruning, segmentation, classification
  and apron detection would each silently no-op.
- **`RunSegmenter` has an iteration cap the C# lacks.** Its walk never consults
  `visitedEdges`, so a ring-shaped footprint with no degree-2 exception loops
  forever. In Rhino that hangs; in a browser it freezes the tab unrecoverably.
- **Mitre buffer via `BufferOp.bufferOp`.** jsts has no
  `geometry.buffer(distance, parameters)` overload, and the plain fallback gives
  round joins — which reintroduces the false corner regions mitre exists to remove.
- **`mulberry32(12345)` for jitter.** `.NET Random(12345)` is not reproducible in
  JS. Deterministic run to run, but not identical to the C#.
- **Real `Coordinate` instances everywhere.** jsts calls `.copy()` internally; a
  duck-typed `{x, y}` fails deep inside the triangulation.

### Comb fragmentation — fixed

The port initially reported **2 DRIVE / 19 LOT** on `option_1.svg`, longest run
50 ft, where the answer is one ~300 ft drive. Two independent causes, both fixed.

**1. Torn degree-4 medial vertices.** The plan is not a comb — measured in its own
rotated frame it is a straight band **24.0 ft x 321 ft** with nine shallow
bump-outs 6.1 ft deep. Seven are PAIRED (facing each other at the same station).
Where bays face each other the local free space is a plus, and the medial axis of
a plus is an **X**: one degree-4 vertex pinned by all four bay-mouth corners
(predicted 27.5 ft across, measured 27.7-28.0 on a 24.0 ft band). Degree 4 is
degenerate, and every Voronoi construction splits it into two degree-3 nodes
joined by a hair — **seven pairs, 0.037-0.193 ft apart**, against a next-shortest
genuine branch-to-branch chain of 20.3 ft.

Nothing downstream recovers. Pruning never touches an edge between two branch
nodes, and `try_join` needs an *identical* shared end node, which is exactly what
the tear destroys. That is why merge demonstrably reassembles the spine at the two
SINGLE bays and cannot at the seven PAIRED ones.

`collapse_degenerate_junctions` welds them, and `constant_width_runs` now sights
straight through a junction when three gates agree: the legs stay inside their own
corridor (30 deg, derived as sin(turn) < 1/2), they agree in width to the existing
run tolerance, and the pair carries the widest corridor at that junction. **No new
tuned constant** — every threshold is the boundary sample spacing, the local
width, or the tolerance already passed in.

**2. MedianFinder claimed 24 medians on a plan with none.** `reach =
area/perimeter` is 9.67 ft, so closing fills any gap under 19.3 ft, and every bay
mouth is 14.5 ft. A real median is **enclosed** by paving: a thin collar around it
lies entirely on paving. A closed-off notch is not — half its collar sticks out
into open ground. Measured: all 14 survivors of a first, more brittle test scored
**0.47-0.66 enclosure** against ~1.0 for a genuine void, so the cut sits at 0.9.

These two were coupled. With medians on, bridging deformed the drive enough that
the junction weld stopped firing at all (`junctions_collapsed: 0`), so the median
fix was a precondition for the segmentation fix rather than a separate cleanup.

| | before | after |
|---|---|---|
| classified | 2 DRIVE / 19 LOT | **3 DRIVE / 11 LOT** |
| longest run | LOT, 50 ft | **DRIVE, 298 ft at 24.2 ft, aspect 12.3** |
| false medians | 24 | **0** |
| junctions welded | — | 7 |

`DRIVE_ASPECT_RATIO` stays 2.5, untouched, so the 73/28 = 2.6 fixture is unaffected.

### RegionBuilder + ApronFinder — integrated

`identify()` now also returns `aprons` and `regions`.

**ApronFinder runs two independent methods and scores their agreement.**

*Method 1, throat test with refitted arcs.* The SVG carries no `A` commands, so
arcs are recovered from the tessellation: group vertices whose turn angle is in
[0.05, 20) deg, require >= 8 of them, fit a circle by algebraic least squares.
Measured live on `option_1.svg`: **two arcs at radius 11.00 ft, fit error 0.0019
and 0.0029 ft** — about 4x below the 0.01 ft `MouthTrim` the throat test works
to, which is what makes refitting safe here. `ThroatWidthRatio` stays 1.15.

*Method 2, plot-line trim.* Paving outside the property line is apron by
definition. It degrades cleanly: with no plot ring supplied it reports
`ran: false, cause: "no-plot-line"` rather than an empty list, so
"could not test" never reads as "no apron here".

Result on the test plan: **1 apron, verdict `aprons-found`, confidence
`probable` (one test only)**, with the summary naming the test that could not run.

**RegionBuilder** ports the snap-round + polygonize split. Two jsts-specific
hazards were measured and handled in `snap_round_polygonize`:

- jsts ships the legacy `MCIndexSnapRounder`, which snaps only computed
  intersections and leaves original vertices off-grid. Without a
  `GeometryPrecisionReducer` pre-pass it returns **zero** faces, not fewer.
- A zero-length cut reduces to an EMPTY LineString and the noder then walks off
  its coordinate array, taking the whole analysis down with a bare TypeError.

### Delineation — ported, and Part 1 is now complete

`delineation.ts` ports `SkeletonPreview.cs`'s cut construction, the last piece.

A cut comes from the footprint's OWN edges, using the skeleton only to know which
way the drive runs: find the two boundary walls parallel to the drive axis and
nearest the spine, take whichever ends first, and cut perpendicular to that wall
across to the other. Squaring to the wall rather than to the skeleton axis matters
because skeleton nodes zigzag by hundredths of a foot — invisible in a direction
test, enough to tilt a 12 ft cut out of square.

The `reach` constraint is carried across verbatim. Without it a faceted flare
120 ft away throws off dozens of near-parallel edges, one of which sat 8.89 ft
from the spine against the real wall's 9.82 ft; it won, the cut was built at the
apron instead of the junction, and a drive running into a parking block produced
no cut at all with the LOT lost entirely.

Apron mouths then displace any run-boundary cut they duplicate or cross — two
cuts meeting inside the paving describe one transition, and the mouth is the
definitional one.

**Measured on `option_1.svg`:** 1 cut, 24 ft, at the apron mouth. Two regions:

| region | area | dimensions |
|---|---|---|
| DRIVE | 9,207 sf | L 324 / W 23.1 ft |
| APRON | 318 sf | L 46 / W 9.4 ft |

9,207 + 318 = **9,525 sq ft, exactly the paving area** — the split loses nothing.

### Region labels: area from the region, dimensions from its longest run

Neither source alone is right, and both failure modes were measured:

- **Owning run alone** — face ownership resolves ties by run order (deliberate and
  regression-tested), so the winner was a 9 ft stub inside the 9,207 sq ft drive.
  Correct category, misleading dimensions.
- **`2*area/perimeter` on the face** — every bay mouth inflates the perimeter, so
  it reported L465/W19.8 where the skeleton measures L324/W23.

Area comes from the region's real paving; length and width from the longest run
inside it, which is the spine a width check is actually about.

## Part 1 status

| Module | Ported | Verified on a real plan |
|---|---|---|
| skeleton-graph, width-profile, skeleton-pruning | ✅ | ✅ |
| run-segmenter (+ junction weld) | ✅ | ✅ 7 welds |
| classifier (+ min lot extent) | ✅ | ✅ |
| skeleton-extractor, median-finder | ✅ | ✅ 0 false medians |
| apron-finder (throat + plot trim) | ✅ | ✅ 1 apron, arcs refit to 0.002 ft |
| region-builder, delineation | ✅ | ✅ 2 regions, exact area split |

Not ported: nothing from Part 1. The Rhino prototype's identification stage is
fully represented here.
