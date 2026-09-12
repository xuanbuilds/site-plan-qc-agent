# Driveway Checker — Session Handoff

Everything a fresh session needs to continue this work. Written 2026-08-22.

---

## 1. What this is

**Cedar Build "Site Plan QC Agent", Section 1 — the driveway checker.**

Takes a paved footprint as a single flat Rhino **Brep** — with *no* CAD metadata, layers, or
annotations — and identifies its functional zones from **shape alone**, so the right numeric
code check can later be applied to the right zone.

Current categories: **DRIVE**, **LOT**, **APRON**.

The deliberate constraint driving everything: metadata is fragile and inconsistent across
sources, so shape is the only signal used. 3D concerns (slope, drainage) are an additive
layer much later, out of scope now.

**Not to be confused with** the other "Cedar + Grasshopper" project (the feasibility-rebuild
scripts `ContextModel.py` / `DesignExport.py`). Same client, unrelated codebase.

---

## 2. Where everything lives

**⚠ The project folder was renamed. Current path:**

```
C:\XY\prototype\260819_Site Plan QC Agent\driveway_check_rhino\
```

(was `C:\XY\platform_prototype\...` — any older reference is stale)

| Path | Role |
|---|---|
| `src/Part1_Identify/Core/*.cs` | Part 1 geometry/logic. **No RhinoCommon** — plain NTS only. |
| `src/Part1_Identify/*.cs` | Part 1, RhinoCommon-facing (`BrepArcs`, `IdentifyRun`, `SkeletonPreview`). |
| `src/Shared/*.cs` | Rhino ↔ NTS plumbing every part needs. |
| `src/Part2_Dimensions/` | Part 2 — empty, see its README. |
| `src/Part3_CodeCheck/` | Part 3 — empty, see its README. |
| `src/GhEntryPoint.csx` | The control flow: part 1 → part 2 → part 3. |
| `tools/build_single_file.ps1` | Regenerates the master file from `src/`. |
| `driveway_checker.cs` | **Consolidated single-file build — this is what Grasshopper actually reads.** |
| `..\driveway_checker.3dm` | The user's test shapes. |
| `..\driveway_checker.gh` | The Grasshopper definition. |

**`src/` is organised by the three parts** (restructured 2026-08-31), one folder each, with the
Core / RhinoCommon split kept *inside* each part. That split is what lets Core be `#load`-ed and
tested standalone, which is the entire dev loop on a machine with no .NET SDK, so it has to
survive any future reorganisation. Parts are **folders, not single files** — Part 1 alone is
~1500 lines across 15 files. Namespaces follow the folders: `DrivewayChecker.Identify.Core`,
`DrivewayChecker.Identify`, `DrivewayChecker.Shared`.

There is still exactly one file Grasshopper reads, and it is generated, so nothing is referenced
file by file.

> **⚠ A `using` directive must sit on its own line ending in `;`, with any comment on the line
> above it.** The generator hoists usings by matching that shape; one with a trailing comment is
> not recognised, stays in the body, lands after an earlier file’s namespace, and the compiler
> rejects the whole master file with *"a using clause must precede all other elements"*. This
> happened during the restructure. The generator now throws instead of emitting a broken file.

`src/` is the source of truth; `driveway_checker.cs` is a concatenation of it plus a GH entry
point at the bottom.

> **Hand-sync hazard — RESOLVED 2026-08-31.** `driveway_checker.cs` is now generated, never
> hand-edited:
>
> ```
> powershell -ExecutionPolicy Bypass -File toolsuild_single_file.ps1
> ```
>
> The GH entry point moved out of the generated file into `src/GhEntryPoint.csx` so it has a
> home of its own. Output is a **verbatim** concatenation of `src/` — the only edit is
> hoisting each file's `using` lines into one block at the top, which works because
> file-scope usings apply to every namespace declared in the file, so no name qualification is
> needed. Verbatim matters: checking for drift is now a plain text comparison.
>
> The pre-existing hand-synced copy was checked before being replaced: eight of its fourteen
> sections differed textually, but **all fourteen were identical once comments and namespace
> qualification were normalised**. GH had been running the right logic. Run the generator after
> every `src/` change, then recompute.

---

## 3. Environment and how to work

### Rhino / MCP
- The `Rhino-MCP-Platform` plugin is installed; `mcp__Rhino_MCP_Platform__*` tools drive the
  live Rhino session. No pairing step needed.
- **This machine has the .NET runtime but no SDK.** There is no `dotnet build`. The entire dev
  loop is Rhino 8's Roslyn scripting via the `run_csharp` MCP tool.

### The testing technique to use (important)
`#load` the `src/` files directly in dependency order, prefixed by the NTS reference. This
tests the *real* sources and makes rotation sweeps cheap:

```csharp
#r "C:\Users\XUANB\.nuget\packages\nettopologysuite\2.5.0\lib\netstandard2.0\NetTopologySuite.dll"
#load "...\src\Part1_Identify\Core\SkeletonGraph.cs"
#load "...\src\Part1_Identify\Core\BoundaryArc.cs"
#load "...\src\Part1_Identify\Core\MedianFinder.cs"
#load "...\src\Part1_Identify\Core\SkeletonExtractor.cs"
#load "...\src\Part1_Identify\Core\WidthProfile.cs"
#load "...\src\Part1_Identify\Core\SkeletonPruning.cs"
#load "...\src\Part1_Identify\Core\RunSegmenter.cs"
#load "...\src\Part1_Identify\Core\Classifier.cs"
#load "...\src\Part1_Identify\Core\ApronFinder.cs"
#load "...\src\Shared\PolylineCoordinates.cs"
#load "...\src\Shared\BrepToPolygon.cs"
#load "...\src\Shared\CurveToLineString.cs"
#load "...\src\Part1_Identify\BrepArcs.cs"
#load "...\src\Part1_Identify\IdentifyRun.cs"
#load "...\src\Part1_Identify\SkeletonPreview.cs"
```

Do **not** `#load` the consolidated `driveway_checker.cs` — its GH entry point references the
ambient `S` / `C` / `regulations` pins, which don't exist outside the script component.

### Grasshopper
- The GH Script component's `script` input is fed a **file path string** from a Panel. The
  RhinoCode `Script`-typed parameter resolves that path into the file's live content at solve
  time. So to push a change: **edit the `.cs` on disk, then trigger a recompute.** No panel or
  script-text editing.
- Safe recompute: **`g1_solve_graph()`** (no args). Standard GH API. If it errors once, just
  retry — it has done that harmlessly.
- `#r "C:\full\path\to\NetTopologySuite.dll"` **does** resolve inside a live GH script
  component. `#r "nuget: ..."` does **not** (works only in standalone `run_csharp`).

### GH input pin spec
| Pin | Type hint | Access | Status |
|---|---|---|---|
| `script` | Script | Item | Path to `driveway_checker.cs` |
| `regulations` | — | Item | Placeholder, unused |
| `S` | **Brep** (or Geometry) | Item | The paved footprint |
| `C` | Curve | **List** | Road centerlines — *accepted but unused* |

Outputs: `out`, `edges`, `tag_planes`, `tag_texts`, `delineation_lines`.

---

## 4. The pipeline

```
Brep
 ├─ BrepToPolygon.Convert ──► NTS Polygon   (faceted outline)
 └─ BrepArcs.Extract ───────► List<BoundaryArc>  (arcs preserved, NOT faceted away)
        │
        ▼
SkeletonExtractor.ExtractSkeleton   Voronoi-based medial axis
        ▼
WidthProfile.Compute                local width at each node
        ▼
SkeletonPruning.Prune               removes corner-artifact spurs
        ▼
RunSegmenter.ConstantWidthRuns      splits spine into runs
        ▼
Classifier.ClassifyRuns             aspect ratio → Drive / Lot  (+ merge)
        ▼
SkeletonPreview.Build
   ├─ BuildDelineationLines   cuts at Drive/Lot boundaries  (wall-anchored)
   ├─ ApronFinder.Find        cuts at filleted flares
   └─ TagRealFaces            split polygon → tag each REAL face
```

### Key architectural principle (the user's call, and it is correct)
> **The spine is fictional; the split surfaces are real.**

The skeleton exists *only* to help locate delineation lines. Identification happens on the
**faces produced by splitting the footprint along those lines** — not on skeleton runs. This
was adopted because one physical Lot's medial axis is a small *tree* (it forks once per
connecting Drive), so a single real Lot produced 2+ runs and therefore 2+ "Lot" labels.
Splitting and tagging faces fixes that automatically — two adjacent same-category runs with no
cut between them land in the same face, so no merge-faces step is needed.

### Delineation lines — the wall-anchored algorithm (`SkeletonPreview.DelineationLineAt`)
This took **three** attempts. The final one came from the user's own geometric description and
is simpler than all my attempts:

1. Rough axis = junction node → run's far endpoint. **Skeleton used only for direction.**
2. `NearestParallelWall` — the boundary edge parallel to that axis (within 2°) closest to the
   spine, on each side. Those are the drive's own two side walls.
3. Take each wall's endpoint furthest toward the junction. **For a fillet, that endpoint IS
   the arc's tangent point, for free** — no arc-specific code needed.
4. Cut at whichever wall ends *first*. (Handles the asymmetric case where one side is flush.)
5. Square the cut to the **anchor wall's own direction**, not the skeleton axis, then intersect
   the opposite wall's line.

Step 5 is essential: using the skeleton axis left a visible ~0.26 ft tilt over an 8 ft cut,
because skeleton nodes zigzag by hundredths of a foot (real, confirmed by dumping coordinates).
Walls are exact geometry. **There is no width tolerance and no search reach anywhere in this
code** — that is what finally made it robust.

### Apron detection (`ApronFinder`)
From the user's definition: *"when a drive flares out with fillets and ends in a wider segment
than the drive itself but is obviously not a lot, then it is likely an apron."*

For each pair of `BoundaryArc`s, try all 4 tangent-point pairings. A pairing is an apron when:
- the two tangent points that **face each other across the paving** are **closer together**
  than the two at the arcs' other ends (it genuinely widens on the way out), **and**
- `EndsHere` — the paving beyond the mouth is shallow: `deepest <= OuterWidth`.

Returns `Apron(MouthA, MouthB, Inside, OuterWidth)`. `Inside` is a point known to be within the
apron, used later to recognise which split face is the apron. `TagRealFaces` checks the apron
marker **before** the run lookup, because the run whose spine passes through an apron is the
*drive's* run and would otherwise label it DRIVE.

---

## 5. Current state — verified working

**Real geometry, 2026-08-31: all 14 breps in the open document × 10 rotations
(0/15/37/−20/60/90/123/−47/5/−75°) = 140 cases, every one stable and correct**, verified both standalone via
`#load` and through the live GH component reading the generated `driveway_checker.cs`
(21 tags, 12 cuts, no component errors).

| Brep | Result, all 6 rotations |
|---|---|
| PadAndStrip | `DRIVE+LOT` |
| LotOnly (×2) | `LOT` / `DRIVE` |
| ThinL_PadAndStrip | `DRIVE+LOT` |
| StapleShape_Test | `DRIVE+DRIVE+LOT` |
| StapleShape_Test (2nd) | `DRIVE+DRIVE+DRIVE+LOT` |
| `d7d872ca` filleted notch | `DRIVE+DRIVE+DRIVE+LOT`, **no false APRON** |
| `6d72bcf8` flared drive | `DRIVE+APRON` |
| `169c4681` same, rotated | `DRIVE+APRON` |
| `b02eaf59` divided drive | `DRIVE + APRON` — identical to its two undivided twins |

`169c4681` is a rotated copy of `6d72bcf8` — the same fillets (r=7.27, r=13.76) and the same
18.92 ft mouth — so the pair is a free rotation check on anything arc-driven.

Tag *order* varies with rotation (the polygonizer's face order); the multiset does not. Don't
read anything into the ordering.

### Earlier synthetic run (fixtures now lost — see §6e)

**26 / 27 synthetic cases pass**, all rotation-swept.

| Fixture | Result |
|---|---|
| strip+pad | `DRIVE+LOT` at 0/15/37/−20° |
| T-notch+wing | `DRIVE+DRIVE+DRIVE+LOT` at 0/15/37° |
| staple | `DRIVE+DRIVE+LOT` at 0/15/−47° |
| L drive+pad (60, 90) | `DRIVE+LOT` |
| square | `LOT` |
| thin strip | `DRIVE` |
| flared drive | `APRON+DRIVE` at 0/15/−33/90/−70° |
| flare + pad | `APRON+DRIVE+LOT` at 0/15/−33/60° |
| filleted staple (r=30,60) | `DRIVE+DRIVE+LOT`, no false APRON, at 0/15/−33/60° |

**⚠ But:** all of these are shapes *I invented*. The user's real geometry has repeatedly found
failures my synthetic fixtures miss. **Test against `driveway_checker.3dm` first, always.**

---

## 6. Open issues

### 6a. RESOLVED 2026-08-31 — apron false positive (`d7d872ca`)

A diagonal chord across the **interior corner pocket** where the filleted notch meets the arm
was labelled APRON. Fixed by a **throat test** in `ApronFinder.IsThroat`, which now runs
before `EndsHere`. `ApronFinder.Find` takes the `SkeletonGraph` and `WidthProfile`.

**The rule that worked, and why it needs no shape-specific number.** The local width at a spine
point is the *narrowest* chord across the paving there (it is the inscribed circle's diameter),
so every chord is at least the local width, and one matches it only when it genuinely is the
cross-section. A diagonal slicing across a corner is longer than the paving is wide where it
crosses the spine. Measured on the real breps:

| mouth | mouthW / localW | crossing angle | verdict |
|---|---|---|---|
| `6d72bcf8` flare | **1.04** | 79° | real apron |
| `169c4681` flare (rotated) | **1.04** | 73° | real apron |
| `d7d872ca` notch diagonal | 1.28 | 76° | false |
| `d7d872ca` | 1.55 | 79° | false |
| `d7d872ca` | 2.09 | 42° | false |
| `6d72bcf8` mismatched pairing | 1.95 | 52° | false |
| `d7d872ca` notch ceiling | — | no crossing | false |

`ThroatWidthRatio = 1.15` sits mid-gap between 1.04 and 1.28. The ratio is dimensionless and
came out **identical at both rotations** of the same shape, even though its two fillets differ
in size (r=7.27 against r=13.76) so its tangent points aren't symmetric.

> **⚠ Half the originally proposed fix was wrong — do not reinstate it.** The design above also
> called for the spine to cross the mouth *roughly perpendicular*. Measured, that does **not**
> discriminate: real mouths cross at 79° and 73°, false diagonals at 79° and 76°. The ranges
> overlap outright, so an angle window would either keep the false ones or start rejecting real
> aprons on rotation alone. Only the width-match half survives. A mouth the spine never crosses
> is still rejected (it is a cross-section of nothing) — that alone kills the notch-ceiling chord.

Also tested and rejected: **arc-centre containment** as a convex/concave discriminator. Every
arc centre lies outside the polygon, on real and false alike.

### 6b. RESOLVED 2026-08-31 — flare tagged DRIVE (`6d72bcf8`) was a lost input, not a rule

Root cause was **not** arc-pair selection. `PolyCurve.Explode()` un-joins only **one level**,
and a real filleted outline nests: each long side of the flared drive came back as a single
PolyCurve holding its straight run already joined to its fillet. `TryGetArc` on that whole
line+arc segment fails, so `BrepArcs.Extract` found **0 arcs** — 4 shallow segments against 6
segments and both real fillets when flattened recursively. With no arcs `ApronFinder` has
nothing to pair, so the apron went undetected and the flare inherited the drive's label. The
cut still appeared because the run-boundary pass makes it independently.

Fixed by a recursive `Flatten` in `BrepArcs`. **This is the "lost input" failure mode from
§8 again** (cf. Surface-instead-of-Brep): it reads as a broken classifier rather than missing
geometry. When a shape-driven rule mysteriously finds nothing, check what actually reached it.

### 6b-2. Sliver face where an apron mouth met a run-boundary cut

Surfaced once §6b was fixed. Both passes locate the same throat, but the run-boundary pass
sizes it from the drive's side walls while the mouth spans the fillets' tangent points — equal
only when the fillets are symmetric. On `6d72bcf8` they are not: 18.00 ft square to the drive
against an 18.92 ft mouth, sharing one end and splaying 5.6 ft apart at the other, far too wide
for `SameCut`'s 0.05 ft. Both survived and the sliver between them became its own face with a
spurious DRIVE tag.

Fixed by `SkeletonPreview.Crosses`: two cuts that meet inside the paving describe one
transition, and the mouth wins (the tangent points *are* where the apron starts). No tolerance
involved — either the segments intersect or they don't. `SameCut` is still needed for the
exactly-coincident case, which reports parallel and so never "crosses".

### 6b-3. `EndsHere` may now be dead code

With the throat test in front of it, `EndsHere` rejects **nothing** it doesn't already reject:
disabling it leaves all 54 real-geometry cases byte-identical. §6a had already concluded depth
"was never the discriminating signal". It was **kept** rather than deleted only because the
synthetic filleted-staple fixture it was built for is among those lost (§6e), so there is no way
to check it isn't still earning its keep there. Delete it once that fixture is rebuilt.

### 6c. Smaller known issues
> All of these were found on synthetic fixtures that no longer exist (§6e), so none of them
> could be re-checked on 2026-08-31. The 54 real-geometry cases are clean. Treat this list as
> unverified rather than current.

- **T-notch+wing at −20°** → 2 cuts / 3 tags instead of 3 / 4. Rotation-sensitivity remaining
  in cut generation (distinct from the noding issue, which is fixed).
- **strip+pad at exactly 90°** → both faces tagged `LOT`. Aspect ratio is rotation-invariant,
  so this is unexpected. Undiagnosed.
- **filleted staple r=30 @0°** → 3 cuts instead of 2, loses its LOT tag. One configuration only.
- **Pads ≥105 ft × 30 ft classify as DRIVE.** Arguably correct under a shape-only rule (a
  105×30 strip really is drive-shaped, AR ≈ 2.5). Flagged as a definitional boundary, not a
  bug — revisit only if the user says such a region should be a LOT.

### 6d. Not implemented
- **APRON has no street check.** It keys purely on shape (filleted + widens + terminal). A
  filleted flare terminating *anywhere* reads as APRON. `road_centerlines` is the natural
  discriminator.
- **`road_centerlines` (`C`) is accepted but entirely unused.** The user's stated intent: *"if
  this narrow piece is near this curve, it is very likely drive, the other one is near the other
  curve, very likely drive as well."* Open design question they raised and never answered: what
  happens to a narrow piece far from *every* road — still DRIVE by aspect ratio, or reclassified?
- **`regulations` folder path** — placeholder, no code checking exists.
- **No `Brep.Split`** yet — cuts are preview lines only; the surfaces aren't actually split into
  measurable sub-surfaces. That was always the eventual goal.

### 6d-2. RESOLVED 2026-08-31 — divided drives (median)

A drive split into two travel lanes by a grass median read as **two separate
DRIVE regions**, and its apron went **undetected entirely**. One root cause: the
model had no notion of *a void that belongs to the drive*.

The apron failure is the instructive part. The fillets, the throat pairing and
the widening test were all fine; `SpansPaving` rejected the mouth because it
crossed **2.13 ft of grass**. The median tip ends at y=49.5100 and the apron
mouth sits at y=49.5118 — 0.002 ft apart, because a designer ends the median
exactly where the apron begins. Correct practice, and it blinds the detector.

**Fix: bridge the median before analysis, measure on the real paving.** Same
move the architecture already makes one level down, applied to the footprint.
`MedianFinder` → `IdentifyRun` carries `Polygon` (real) and `Analysis`
(bridged) → `SkeletonPreview` finds cuts/aprons on the bridged one and tags
faces trimmed back to the real one.

**Detection: morphological closing with MITRE joins, radius = area / perimeter.**
- `reach = area / perimeter` is half the width of any elongated region, so
  closing at that radius bridges exactly the gaps narrower than the paving
  flanking them — the engineering meaning of a median, not a fitted number. A
  staple's 40 ft gap between 13.3 ft legs is far too wide to seal.
- **Mitre joins are the whole trick.** Round joins cannot rebuild a sharp corner
  on the way back, so every concave corner returns as a filled wedge — measured,
  seven false regions of 4–21 sq ft, which then need a size rule to filter.
  Mitre joins rebuild the corner exactly and those never appear.
- Result: across 14 footprints × 8 rotations, the **only** thing filled is the
  one real median, stable at 227 sq ft to the square foot at every rotation.

> **⚠ Two approaches were tried first and failed — do not redo them.**
> 1. **Convex-hull difference.** The hull closes a median's open end with a
>    diagonal, turning a constant-width strip into a tapering wedge:
>    `MinimumDiameter` read **9.98 ft** against a true gap of 2.1 ft, rejecting
>    it outright. Worse, on a tilted divided drive the hull adds parallel slivers
>    on *both* outer sides, and a probe cast across the footprint cannot tell
>    them from the median — it finds paving on both sides either way.
> 2. **Probing for "narrower than the paving it separates".** Sound in principle,
>    but it needs the hull to isolate a candidate first, so it inherits (1).

### 6d-3. Latent: the two lanes of a divided drive sometimes merge into one piece

Not visible in the output, but it will matter later.

The two lanes genuinely meet at a single point — the median tip lands exactly on
the apron mouth — and whether NTS resolves that touch as connected or separated
flips with rotation: measured, 7 of 10 rotations return two lanes and three
return one merged piece of exactly their combined area (921 + 896 = 1817).

**The tags are unaffected**, because a drive is labelled once per face rather
than once per lane (the user's call: a median splits a drive in two
geometrically, but it is one drive conceptually and gets one DRIVE label like
any other). The divided drive reports `DRIVE + APRON`, identical to its
undivided twins, at every rotation.

It bites when each lane's width is checked separately: a merged pair would
measure as one 18 ft drive rather than two 8 ft lanes. Fix it then, and probably
by deriving the lanes from the median's two sides rather than from the
connectivity of an intersection — a real geometric degeneracy is not something
to tune away.

### 6e. ⚠ The synthetic fixture suite does not exist on disk

`tests/` holds **three** shapes (`CenteredTPad`, `OffsetLPad`, `StripAisleWithStallNotch`)
and no rotation sweep. None of the nine fixtures named in §5's earlier table — staple, flared
drive, filleted staple, square, thin strip, L drive+pad, T-notch+wing — are among them. They
were built inline in `run_csharp` sessions and never landed. **The 26/27 result cannot be
reproduced.**

`tests/SkeletonSpike.cs` is also stale: it reads `c.Zone`, which no longer exists on
`ClassifiedRun` (it is `Category`), so it does not compile. Both files date from 2026-08-19,
before the classifier was rewritten.

Consequences, both live: §6c's issues can't be re-checked, and `EndsHere` can't be deleted
(§6b-3). Rebuilding the suite is cheap and unblocks both.

### 6f. No version control

There is no git repository anywhere up the tree. Combined with a generated duplicate file and a
missing test suite, nothing here has a recovery path. `git init` before the next substantial
change.

---

## 7. ⚠ Standing constraints — read before touching anything

### NEVER: reflection on RhinoCode internals
Do **not** manipulate `IScriptComponent` / `IScriptObject` internals — `Text`,
`HasExternScript`, `Save()`, `ReBuild()`, `ParamsCollect`/`ParamsApply`.

This is believed to have caused a **real cross-document failure**: all C# components vanished
from an unrelated GH document, fixed only by restarting Rhino. A `Save()` call had hung
mid-operation the day before. Causation was never fully confirmed, but the user was rightly
alarmed and this category is **off-limits, standing**.

Safe and fine: the `g1_*` API, `IGH_Param` / `SetPersistentData` / `Script_ClearPersistentData`,
`IGH_VariableParameterComponent.CreateParameter`, `GH_Panel` / `GH_ColourSwatch` property sets.

### NEVER: spawn a second Rhino slot
At the end of this session I called `spawn_slot` to open the test file without polluting the
user's open doc. **The new instance was assigned the same slot id (`aardvark`) and same port
(10500) as their live session, collided with it, and crashed.** The router then reported no
Rhino at all. I disrupted their working session and had to apologise.

**To inspect a .3dm without touching the open doc, use `Rhino.FileIO.File3dm.Read(path)` inside
`run_csharp`** — it reads the file without importing anything. That is the safe path I should
have used.

### NEVER: bake into the Rhino document
All visualization is Grasshopper-preview-only. No `doc.Objects.Add*`. Earlier clutter came from
exactly this mistake.

---

## 8. Hard-won lessons (do not rediscover these)

### NTS floating-point robustness — the recurring theme
Three separate bugs, same root cause. **When NTS output changes *non-monotonically* with a tiny
geometric nudge, reach for snap-rounding / a fixed `PrecisionModel` — do not tune the geometry.**

1. **`Union()` failed to node** where a cut endpoint touched the boundary → `Polygonizer`
   silently returned too few faces on rotated shapes. The tell: nudging cut length gave 3 faces
   at 0.001 ft overshoot, 2 at 0.01, 3 at 0.1, 4 at 1.0. **Fix:**
   `new GeometryNoder(new PrecisionModel(1e4)).Node(geoms)` feeding `Polygonizer`. Verified
   identical for grid scales across 1e2..1e6, so `SnapGridScale = 1e4` is not a magic number.
   An overshoot hack was tried and **rejected** — it was tuning noise.
2. **`polygon.Covers(fullMouthSegment)`** failed on rotated shapes — tangent points sit exactly
   ON the boundary, and "exactly" is a few bits. **Fix:** test a slightly *shortened* copy
   (`MouthTrim = 0.01`).
3. **Voronoi `TopologyException: found non-noded intersection`** on a real footprint, surviving
   a 5% spacing sweep. Scaling spacing perturbs all points *as a group*, preserving the
   degeneracy on symmetric shapes. **Fix:** `maxAttempts` 5→12 plus a small **per-point random
   jitter** (`sampleSpacing * 1e-4`, seeded `Random(12345)`) which perturbs points
   *independently*. Verified harmless: staple 256→258 nodes, strip+pad identical at 59.

### Rhino ↔ NTS conversion traps
- **`Polyline.IsClosed` is tolerance-based; NTS requires bit-identical** first/last coordinates.
  Rotated shapes reported closed but `CreatePolygon` threw `points must form a closed
  linestring`. Fix: compare `coords[0].Equals2D(coords[^1])` directly and **snap** the last onto
  the first (not append — that adds a near-zero-length segment).
- **A `Surface` cannot carry a trim boundary.** An L-shape of true area 5550 becomes 17479 (its
  untrimmed bounding patch) through `UnderlyingSurface()`, outline collapsing 7 points → 5.
  Symptom is deceptive — reads as a broken classifier, not lost input: every shape gets exactly
  one tag and zero cuts, and the giveaway is that **slanted shapes show axis-aligned vertical
  spines** (the bounding box's axis). Hence the hard Brep-only rule.
- **`Point` is ambiguous** — exists in both `Rhino.Geometry` and `NetTopologySuite.Geometries`.
  Fully qualify. `run_csharp` reports this as an *empty* error message; bisect by loading files
  incrementally when that happens.
- **A 3-point "arc" through nearly-collinear points** has an enormous radius and reads as
  `IsLinear` → 0 arcs found. That's the filter working, not a bug. (Cost time once.)

### Logic bugs worth not reintroducing
- **`MergeAdjacentSameCategory` must NOT re-classify.** It used to call `Classify()` on the
  merged run, creating a feedback loop: a pad's Lot run absorbs adjacent taper slices → gets
  longer → crosses AR 2.5 → flips to Drive → merges with the real drive → **entire footprint
  becomes one DRIVE**. Measured: 60 ft pad merged to 43/28 = 1.5 (stays Lot ✓); 90 ft pad merged
  to 73/28 = 2.6 (flips ✗). Fix: `Merged()` re-measures but **keeps the constituents' category**.
  This also fixed the long-standing "staple only gets 1 cut" issue as a side effect.
- **`SkeletonPruning.Prune` must snapshot per pass.** Mutating adjacency mid-pass makes a
  *sibling* corner-ear misjudge "is this attached to a real branch" from a stale degree. Evaluate
  all leaves against a frozen start-of-pass snapshot, then apply removals together.
- **`RunSegmenter` does NOT guarantee adjacent runs share an end node.** They can overlap on
  interior nodes or meet across a graph edge. Hence `JunctionNode()` tries: shared end → any
  shared node → any edge spanning the two runs. Assuming shared-ends lost a correctly-classified
  Lot entirely (Drive ended (9,90), Lot ended (0,101)).
- **Duplicate coincident cuts cancel during noding** and stop the split entirely. The apron
  mouth is usually the *same line* the run-boundary pass already produces — a nice independent
  cross-check, but it must be deduped (`SameCut`, either direction, 0.05 ft).

### Failed experiments — do not redo
- **Face→run matching by "most nodes inside".** Tried as the *primary* rule; fixed strip+pad@90
  but **regressed the staple** (`Lot,Drive` → `Drive,Drive`) because a long thin leg carries more
  nodes than the wider crossbar sharing its face. Node count is not a valid proxy for face
  ownership. It survives only as a **fallback** when no run midpoint is inside.
- **Spine-derived delineation lines** (local width sizing, then width-tolerance throat search).
  Two full iterations, both wrong. The boundary walls are the right anchor.
- **`VoronoiDiagramBuilder.Tolerance`** for the TopologyException — tested 0.001 through 1.0,
  all failed identically.

---

## 9. User preferences and working style

- **Code style:** *"very concise and simple code, instead of adding robustness as a prevention…
  very light simple and human readable so eventually engineers can review it."* No defensive
  robustness for out-of-scope cases. Fail-loud guards for mistakes that have *actually happened*
  are welcome (e.g. `BrepToPolygon`'s face-count throw).
- **Comments should explain *why*,** especially the empirical reason a constant exists.
- **Naming:** snake_case for locals/params in new code; types, enums, public methods, properties
  stay PascalCase (they'd clash visually with RhinoCommon/NTS otherwise).
- **Do not calibrate to one shape's scale.** Thresholds tuned to a single fixture get pushed back
  on, correctly. Prefer rules with no tuned constant at all.
- **Baby steps.** The user explicitly wants one thing nailed before moving on.
- **⚠ The single most valuable process lesson:**
  > When the user describes a geometric construction in plain terms and asks *"let me know
  > what's tripping you up"* — **implement their construction directly.** On the delineation
  > lines I burned two iterations refining my own approach before doing what they described,
  > and their version was both correct and simpler. This is recorded as a standing memory.
- **Test against their real geometry, not synthetic fixtures.** Every synthetic suite I built
  went green while their actual shapes kept failing. This burned significant time repeatedly.

---

## 10. Session end state — 2026-08-31

- **Rhino is running** with the test document open; one adopted slot (`aardvark`, pid 27840),
  no collision. Two `rhino-mcp-router.exe` processes are alive — harmless here, but worth a
  glance given the `spawn_slot` incident in §7.
- `driveway_checker.cs` is **generated** (§2) and verified verbatim against `src/`. The live
  GH component recompiled from it and ran all 9 breps: 21 tags, 12 cuts, no errors.
- Both reported failures are fixed and verified on the real geometry at 6 rotations each (§5).
- Nothing is mid-edit or broken.

### Changed this session
| File | Change |
|---|---|
> Paths below are post-restructure (§2). Everything moved on 2026-08-31; the changes
> themselves were made before the move.

| `src/Part1_Identify/BrepArcs.cs` | recursive `Flatten` — nested PolyCurves hid every fillet (§6b) |
| `src/Part1_Identify/Core/ApronFinder.cs` | `IsThroat` + `CrossingParameter`; `Find` takes graph + profile (§6a) |
| `src/Part1_Identify/Core/MedianFinder.cs` | **new** — bridges grass medians for analysis (§6d-2) |
| `src/Part1_Identify/SkeletonPreview.cs` | profile + `Crosses` dedupe (§6b-2); polygonize bridged, trim to paving; one tag per drive |
| `src/Part1_Identify/IdentifyRun.cs` | was `DrivewayCheckerRun.cs`; carries `Polygon` (real) and `Analysis` (bridged) |
| **`src/` restructured by part** | Part1_Identify / Part2_Dimensions / Part3_CodeCheck / Shared (§2) |
| `src/GhEntryPoint.csx` | **new** — extracted from the generated file so it has a home |
| `tools/build_single_file.ps1` | **new** — the generator (§2) |

### 6g. RESOLVED 2026-08-31 -- a drive running into a lot produced no cut

On the curved footprint, the whole shape came back as one `DRIVE` and the
parking block at its top was never found, even though the classifier had
correctly produced a `Lot` run (39ft x 29ft) sharing an endpoint exactly with
the drive run at (1173.1, 164.6).

**Root cause: `NearestParallelWall` ranked candidates on perpendicular offset
alone and ignored where an edge sat ALONG the drive.** Both true side walls were
found parallel at 0.75 degrees -- but 120ft away at the apron, the faceted flare
throws off dozens of 0.11ft edges that are also parallel, and one of them sat
**8.89ft** from the spine against the real wall’s **9.82ft**. It won. The cut was
built down at the apron rather than at the junction, and was then correctly
removed for crossing the apron mouth, so no cut survived at all and the drive
and lot merged into one face.

Fixed by requiring a candidate wall to reach the junction: its along-axis
interval must come within **one local width** of it (zero if it spans the
junction outright). Scale-free, same reasoning as the width-relative rules in
`SkeletonPruning` and `MedianFinder`. The real walls qualify (gap 0 and 6.9ft
against a 20.6ft width) and the apron facets do not (gap ~118ft).

> **Not the 2-degree parallel window.** The first hypothesis was that the chord
> axis from junction to far end diverges from the local spine direction on a
> curved drive -- measured, it does, by 3.01 degrees against a 2.00 degree
> window. But that is a red herring: the walls are parallel to the CHORD at 0.75
> degrees, so they were never rejected on angle. Do not widen that window.

**A second bug fell out with it:** the DRIVE length had been reported as 213.9ft
because the face swallowed the block. It is now 113.6ft, in line with the
undivided twin’s 113.8ft.

### Part 2 started 2026-08-31

`src/` is now organised by the three parts (see §2). Part 1 returns
**`IdentifiedRegion`** (category + bridged face + real paving lanes + owning run)
from `RegionBuilder`, extracted out of `SkeletonPreview` so identification
produces DATA rather than only labels — Part 2 cannot measure a region it was
never handed, and the faces used to be locals that went out of scope once their
tag text was built.

Part 2 (`DimensionRun`) does drive width, folded into the tag as
`DRIVE (w=12.0)` / `DRIVE (w=8.0+8.0, total 18.0)`, and connection radius
`R=10.0` at drive/lot fillets. See `src/Part2_Dimensions/README.md` —
**including its accuracy warning, which blocks Part 3.**

> **⚠ Width is not accurate enough for a code threshold yet.** It reads ~0.04ft
> low and under-resolves anything near the 2ft sample spacing. Measure between
> the parallel boundary walls before wiring up any check.

### Suggested first moves
1. Confirm Rhino/MCP is alive (`list_slots`).
2. Rebuild the synthetic fixture suite and fix `SkeletonSpike.cs` (§6e) — it blocks re-checking
   §6c and deleting `EndsHere` (§6b-3), and it is the cheapest thing on this list.
3. `git init` (§6f).
4. Then the real open question, which is a **scope** question rather than a bug: the spec's
   four-zone taxonomy and street-relational classification vs. the built DRIVE/LOT/APRON
   shape-only rules. `road_centerlines` is still accepted and unused (§6d). Worth settling
   before tuning anything further, since it may move the target.

> **Working reminder that paid off again this session:** the user's real geometry found both
> bugs, and the *proposed* fix for one of them was half wrong (§6a). Measure on their shapes
> before writing the rule, not after.

---

## 11. Part 3 rulebook provenance — 2026-09-08

`src/Part3_CodeCheck/rules.austin-tcm.json` is compiled. 27 provisions, every one carrying a
verbatim `cite.quote` and `needs_review: true`. **No human has signed off on any of them.**

Sources — the complete list, now recorded inside the file under `source.documents` with byte
counts and sha256 prefixes so drift is detectable:

| id | file | coverage |
|---|---|---|
| `tcm-7` | `TCM SECTION 7 DRIVEWAYS.docx` | read in full |
| `tcm-9` | `TCM SECTION 9 PARKING AND LOADING.docx` | read in full |

Present in `C:\XY\260729_feasibility\regulations\Austin` but **not read**, recorded in the file
under `source.documents_present_but_not_read`: TCM Section 3 (design vehicles), LDC 25-6
(the ordinance the TCM implements — the authority if they ever disagree), LDC 25-2 Subch. C
(sets required parking count, currently taken as a site input instead of derived).

JSON has no comment syntax. Provenance lives in `$comment` and `source` keys.

Status split: **4 checkable**, 11 `needs_input`, 6 `needs_geometry`, 6 `out_of_scope`.

### The extraction hazard worth remembering

**Table 7-2 has vertically merged cells and extracts almost entirely blank.** Its values were
reconstructed by hand (Typical 20 ft max at every Street Level; Fire 20 ft at Levels 1–2 then
25 ft; Industrial 25 ft). A naive re-extraction will produce a *wrong* table, not an obviously
empty one. This is the most likely place in the file for a bad number to hide.

Two more traps, recorded in the file's `source.extraction.caveats`:

- Table 7-5 is driveway **spacing** (50–280 ft), not width. An earlier project note had this
  wrong. Width is Table 7-2, and it is a **maximum only** — no minimum applies at the street.
- §7 and §9 both say 20 ft. It is a **MAX** at the street and a **MIN** inside the property
  line. A rule that confuses them inverts its own verdict.
