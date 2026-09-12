# Driveway Checker — Feature Identification Approach

## Problem

Input is a single Rhino brep representing a paved footprint (driveway,
backup aisle, parking, turnarounds) with no CAD metadata — no layers,
no separate curves, no drafter labels. The task: recover functional
zones from shape alone, so the right numeric check (drive strip width,
maneuvering clearance, turning radius) gets applied to the right part
of the geometry.

## Why width alone doesn't classify a zone

A 24 ft wide segment could be a generous drive strip or a standard
two-way backup aisle — the raw number doesn't disambiguate. What
disambiguates it is what the segment *connects to*: a segment
terminating at the street is drive strip; a segment running adjacent
to stall-shaped branches is maneuvering space, regardless of matching
a driveway-width table. Classification needs to be relational (skeleton
graph structure), not just per-segment measurement.

## Chosen approach: deterministic geometric heuristics

Chosen over a trained ML classifier for v1, because:
- No labeled dataset exists or is easy to produce (labeling zone
  boundaries by hand on many example footprints is itself a large task)
- Fully explainable — every classification traces to a specific rule,
  which matters for a QC tool whose output needs to be auditable
- Testable immediately, without training infrastructure

Revisit with a learned model only if heuristics prove insufficient on
real edge cases — not before.

## Pipeline

1. **Skeleton extraction** (`core/skeleton.py`) — approximate medial
   axis via Voronoi diagram of densely-sampled boundary points, keeping
   only ridges whose endpoints fall inside the polygon.
2. **Width profiling** (`core/width_profile.py`) — local footprint
   width at each skeleton node = 2x distance to nearest boundary.
3. **Segmentation** (`width_profile.constant_width_runs`) — split the
   skeleton into runs at every branch point (degree >= 3) and endpoint
   (degree 1), not just at width changes.
4. **Classification** (`core/classify.py`) — label each run using width
   *and* adjacency (what it connects to), not width thresholds alone.

## Architecture: RhinoCommon-independent core

The core pipeline (steps 1-4) takes and returns plain shapely polygons
and coordinate tuples — no RhinoCommon dependency. This means:
- Fast iteration: run and test in any Python environment, no Rhino
  round-trip needed per test
- The only Rhino-coupled code is the adapter layer (`rhino_adapter/`),
  whose entire job is: brep -> polygon in, zone labels -> tagged Rhino
  objects out

## Known limitation: raw skeleton noise (not yet solved)

`tests/test_synthetic_shape.py` proves the pipeline runs end to end,
but on a synthetic 3-zone test shape it produced **21 segmented runs**,
not 3. This is a known characteristic of Voronoi-based medial axis:
spurious short branches appear near every polygon corner, not just at
real zone boundaries.

**Next required step:** a pruning pass that collapses skeleton branches
below a length threshold (relative to local width) before segmentation
runs. This is standard practice for this class of algorithm and is not
optional polish — without it, classification output will be too noisy
to use. Not yet implemented.

## Known limitation: classify.py thresholds are placeholders

The width/variance thresholds in `classify.py` (e.g. "avg_width > 15"
for turnaround detection) are illustrative, not derived from the Austin
TCM values gathered separately (Table 7-5, 433S standard details).
They need to be replaced once real test breps are available, and the
thresholds should probably come from the corpus work rather than being
hardcoded guesses.

## Open questions

- What does a *real* driveway+aisle+stall brep from Cedar's pipeline
  actually look like? The synthetic test shape is a guess at plausible
  geometry, not validated against a real export.
- Should turning-radius / swept-path checking be a separate module
  entirely? It's a path-clearance problem (does a turning template
  clear the curb), not a static-width problem like the others — noted
  in the original conversation, not yet designed.
