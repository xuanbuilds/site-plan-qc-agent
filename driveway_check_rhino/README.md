# Driveway Checker

Section 1 of Cedar's Site Plan QC agent. Identifies functional zones in a
paved footprint — **DRIVE**, **LOT**, **APRON** — from a single flat Rhino
brep, using pattern recognition on shape and adjacency alone. No CAD
metadata, layers, or annotations are assumed: metadata is fragile and
inconsistent across sources, so shape is the only signal used.

`reference/docs/approach.md` has the original design rationale. Read
**`HANDOFF.md`** before changing anything — it carries the standing
constraints (§7), the hard-won NTS/Rhino lessons (§8), and the current open
issues (§6).

## Status

The pipeline runs end to end in a live Grasshopper component. As of
2026-08-31 all 14 breps in `driveway_checker.3dm`, at 10 rotations each
(140 cases), classify correctly and identically at every rotation (§5 of the
handoff). That includes a drive divided by a grass median, which reports the
same `DRIVE + APRON` as the undivided version of the same shape.

Not built yet: no `Brep.Split`, so cuts are preview lines and the regions
aren't yet real measurable sub-surfaces; no code checking (`regulations` is
a placeholder pin); `road_centerlines` is accepted but unused.

⚠ The synthetic fixture suite under `tests/` is **stale and incomplete** —
three shapes, no rotation sweep, and `SkeletonSpike.cs` no longer compiles
(it reads `c.Zone`, now `c.Category`). See handoff §6e.

## Pipeline

```
Brep
 ├─ BrepToPolygon.Convert ──► NTS Polygon        (faceted outline)
 └─ BrepArcs.Extract ───────► List<BoundaryArc>  (fillets preserved as drawn)
        ▼
MedianFinder         bridges any grass median, for ANALYSIS ONLY
        ▼
SkeletonExtractor    Voronoi-based approximate medial axis
SkeletonPruning      drops corner-artifact spurs
WidthProfile         local width at each node
RunSegmenter         splits the spine into runs
Classifier           aspect ratio -> DRIVE / LOT
SkeletonPreview      delineation lines, then tags the REAL split faces
```

A second split of the same kind runs alongside it: the footprint is analysed
with its medians **bridged**, so a divided drive reads as one drive for the
skeleton and the apron search, but every
face is trimmed back to the **real paving** before it is tagged or measured. A
median is not driveable surface and never enters a width or area check.

**The spine is fictional; the split surfaces are real.** The skeleton exists
only to locate delineation lines. Identification happens on the faces
produced by splitting the footprint along them — one physical lot's medial
axis is a small tree, so tagging runs gave a single lot several labels.

## Layout

The tool has three parts, and `src/` is organised to match. Each part keeps
its own Core / RhinoCommon split, because Core having no RhinoCommon is what
lets it be `#load`-ed and tested standalone.

```
src/
  Part1_Identify/      part 1 -- identify functional zones (built)
    Core/                pure NTS geometry, NO RhinoCommon
    BrepArcs.cs          }
    IdentifyRun.cs       } the RhinoCommon-facing half
    SkeletonPreview.cs   }
  Part2_Dimensions/    part 2 -- retrieve the relevant dimension (empty)
  Part3_CodeCheck/     part 3 -- check it against code (empty)
  Shared/              Rhino <-> NTS plumbing every part needs
  GhEntryPoint.csx     control flow: part 1 -> part 2 -> part 3

tools/                 the master-file generator
tests/                 synthetic fixtures (stale -- see above)
reference/             original Python/shapely prototype; read-only

../driveway_checker.cs   GENERATED master -- the one file Grasshopper reads
```

Namespaces follow the folders: `DrivewayChecker.Identify.Core`,
`DrivewayChecker.Identify`, `DrivewayChecker.Shared`.

## Building

`driveway_checker.cs` is generated. Never hand-edit it:

```bash
powershell -ExecutionPolicy Bypass -File tools\build_single_file.ps1
```

Then trigger a GH recompute (`g1_solve_graph()`). The Script component's
`script` pin is fed the file *path*, so editing the file on disk and
recomputing is the whole deploy step.

## Testing

This machine has the .NET runtime but **no SDK** — there is no `dotnet
build`. The dev loop is Rhino 8's Roslyn scripting over the Rhino MCP
connection (`run_csharp`), `#load`-ing `src/` directly in dependency order
so the real sources are what gets tested:

```csharp
#r "C:\Users\XUANB\.nuget\packages\nettopologysuite\2.5.0\lib\netstandard2.0\NetTopologySuite.dll"
#load "...\src\Part1_Identify\Core\SkeletonGraph.cs"   // then BoundaryArc, MedianFinder,
#load "...\src\Part1_Identify\Core\..."                // SkeletonExtractor, WidthProfile,
                                                        // SkeletonPruning, RunSegmenter,
                                                        // Classifier, ApronFinder; then
                                                        // Shared/, then the rest of
                                                        // Part1_Identify/
```

Use absolute paths, and do **not** `#load` the generated
`driveway_checker.cs` — its entry point references the ambient `S`/`C`/
`regulations` pins, which don't exist outside the script component.

**Test against the real geometry in `driveway_checker.3dm` first, always.**
Every synthetic suite built so far went green while the real shapes kept
failing.
