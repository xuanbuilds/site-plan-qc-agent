# Part 2 — Retrieve Dimensions

Takes the regions Part 1 identified and pulls the measurement each one's code
check needs. Nothing here decides whether a number passes; that is Part 3.

Everything is measured on **real paving** (`IdentifiedRegion.Lanes`), never on
the bridged footprint, so a grass median is never reported as drive surface.

## Built

Format: `CATEGORY (L = ... / W = ...)`, folded into the region's own tag.

- **DRIVE** — a corridor. Width follows its path (so it survives a bend);
  length is `area / width`, which for a near-constant-width strip IS its arc
  length. Verified 60.1 against a true 60, 141.0 against 140.6, 90.2 against 90.
  The skeleton run's own length is NOT used: segmentation trims its ends, so it
  reads ~10% short (53 against a true 60).
- **LOT** — a block. Its minimum-area bounding rectangle IS its L and W, exact
  on real pads (24.0 x 30.0, 40.0 x 50.0, 20.0 x 20.0). The width profile cannot
  be used here: a square's medial axis is a single point, so there is no
  corridor to measure along.
- **Divided drive** — `W = 7.9+2.1+8.0=18.0`. The middle term is the median.
  It has to be shown or the line does not add up: the lanes come to 15.9 while
  the crossing is 18.0. Terms are rounded BEFORE the median is derived, so the
  digits actually printed always balance.
- **Connection radius** at a drive/lot junction: `R=10.0`. Apron arcs excluded
  — a flare describes how the drive meets the street, a different check.

### Known limits of the L figure

- `area / width` assumes the region really is a constant-width strip. Where a
  DRIVE face is not one, it over-reports: the curved footprint reads L = 213.9
  because its face includes a wide portion that classified as DRIVE.
- A LOT's bounding rectangle is a loose fit on an irregular region (76.5 x 60.5
  for a 3865 sq ft lot, ~84% fill). Honest as an overall extent, not as an area.

## ⚠ Accuracy — read before wiring up Part 3

Width comes from the medial axis, and it is **not accurate enough to sit on a
code threshold**:

- reads about **0.04 ft low** throughout (2 ft sample spacing, and skeleton
  nodes zigzag by hundredths). A 12.0 ft minimum would spuriously fail at 11.97.
- **under-resolves** features near the sample spacing: a ~2 ft wide footprint
  measured 1.80 against an exact 2.00, and wobbles 1.5–1.9 across rotations.

The fix is the one that fixed the delineation lines in Part 1: measure
perpendicular between the two parallel boundary walls, which is exact geometry
rather than a sampled approximation. **Do this before any code checking.**

Two rejected alternatives, both measured, both recorded in `DimensionRun`:
minimum of the width profile (dominated by the spine tapering out at each end —
read 4.04, 1.69, 4.92, 0.03 on lanes whose true widths are 8, 18, 8, 9.5), and
the lane's own minimum diameter (exact on a straight region, but 60.00 ft
against a true 18 on a curved drive, because it measures the slab containing
the whole bend).

## Not built

Stall length × width, maneuvering clearance, swept-path/turning-radius
clearance. The `regulations` pin still reaches `IdentifyRun.Analyze` unused.
