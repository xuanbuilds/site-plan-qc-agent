# Driveway Checker

First section of the site plan QC agent. Identifies functional zones
(drive strip / maneuvering / stall bay / turnaround) from a single
Rhino brep footprint, using pattern recognition on shape alone — no
CAD metadata assumed.

See `docs/approach.md` for the full design rationale, known
limitations, and open questions.

## Status: proof of concept, not yet validated

The pipeline runs end to end (`tests/test_synthetic_shape.py`) but
against a synthetic, hand-built test shape only. Two things are
explicitly unfinished:

1. Skeleton pruning — raw output is noisier than it should be (21 runs
   on a synthetic 3-zone shape). See `docs/approach.md`.
2. `rhino_adapter/` — brep extraction and result-tagging are interface
   stubs, intentionally not implemented until a real target brep is
   available to test against.

## Layout

```
driveway_check_rhino/
  core/                  pure geometry, no RhinoCommon — testable standalone
    skeleton.py          approximate medial axis (Voronoi-based)
    width_profile.py     local width along the skeleton
    classify.py          zone labeling (width + adjacency, not width alone)
  rhino_adapter/          RhinoCommon-dependent, thin — runs via run_python
    extract.py           brep -> polygon (STUB)
    apply.py             zone labels -> tagged Rhino objects (STUB)
  tests/
    test_synthetic_shape.py
  docs/
    approach.md
```

## Running the test

```
cd driveway_check_rhino
python3 tests/test_synthetic_shape.py
```

Requires: `shapely`, `scipy`, `numpy`.
