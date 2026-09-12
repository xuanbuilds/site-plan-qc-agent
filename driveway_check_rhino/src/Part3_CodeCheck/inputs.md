# Part 3 — Required Inputs

What the tool needs beyond the paved footprint in order to reach a real verdict
instead of `CANNOT_DETERMINE`. Derived from reading TCM Section 7 (Driveways)
and Section 9 (Parking and Loading) in full.

## A deliberate relaxation

Part 1 was built on "shape only, no metadata" because CAD metadata is fragile and
inconsistent. Supplying stalls as drawn curves relaxes that. It is worth doing —
stall recognition from shape is the hardest problem left in the project, and a
drafter can draw them in minutes — but it is a change to the founding premise,
not an oversight. The tool becomes **shape plus a small, explicit annotation
set**, and that set should stay small and named, never open-ended layer sniffing.

The paving stays continuous. Stalls are drawn *over* it, so subtracting them from
a LOT leaves the aisle. That is what turns one undifferentiated LOT into the
four zones the original spec asked for: **DRIVE / AISLE / STALL / APRON**.

## 1. Geometry to draw

| Input | Form | Unlocks |
|---|---|---|
| **Paved footprint** | Brep, flat, single face | everything (already built) |
| **Lot lines** | closed curve | §7 vs §9 boundary; frontage length; throat length datum |
| **Street frontage** | which lot-line segment(s) front the street | Table 7-4 driveway count; driveway spacing |
| **Stalls** | closed rectangles over the paving | all of Table 9-2; stall count for Table 9-5 |
| **Road centerline** | curve (**pin already exists, unused**) | §7.5.1.3 90-degree angle; street-relative checks |

Optional, each enabling one further check:

| Input | Unlocks |
|---|---|
| Fire lane extent | §9.3.4.2.C — 25 ft inside / 50 ft outside turning radius |
| Gate location | §9.3.4.2.E — 40 ft storage from gate to property line |
| Loading zones | §9.4.1.A — 12 ft x 25 ft minimum |
| Accessible stalls (flagged) | keeps them from failing as undersized standard stalls |
| Storm inlets, intersections | §7.6.2 — 10 ft from inlet, 50 ft from intersection |

## 2. Site parameters (a short form, not geometry)

These appear as conditions in nearly every table. **None are derivable from
shape.** Without them the affected rules must report `CANNOT_DETERMINE`.

| Parameter | Values | Used by |
|---|---|---|
| **Street Level** | 1, 2, 2–3 lane, 3 single lane median, 3–4 multi-lane | Tables 7-1, 7-2, 7-5 |
| **Driveway class** | minor / major — from land use per §7.3.1 & §7.3.2 | Tables 7-1, 7-2, 7-5 |
| **Driveway column** | typical / fire access / industrial | Tables 7-1, 7-2 |
| **Aisle direction** | one-way / two-way, per aisle | §9.3.4.2.H; Table 9-2 aisle width |
| **Left turn allowed** | yes / no | Table 9-5 throat storage |
| **Land use group** | multi-family or commercial / industrial | Table 9-5 |
| **Required parking count** | integer, from LDC | §9.3.2.B — compact ≤ 30% |
| **Dwelling units** | integer | §7.6.1.1 multi-unit residential driveways |
| **High capacity / serves garage** | flags | Table 7-2 note 6 — 32 ft max |

### Minimum viable set

Street Level, driveway class (minor/major), and aisle direction alone unlock the
majority of the checks. The rest each add a single rule.

## 3. What becomes checkable

| Rule | Needs |
|---|---|
| §9.3.4.2.H internal circulation min width (20 two-way / 10 one-way) | aisle direction only |
| §9.3.4.3.B minor driveway min length 20 ft | **nothing new** |
| §7.5.1.3 driveway angle 90 degrees | road centerline |
| §7 Table 7-2 max throat width | lot lines, Street Level, class, column |
| §7 Table 7-1 curb radius | Street Level, class, column (arcs already extracted) |
| §9 Table 9-2 stall width / depth / angle | stalls |
| §9 Table 9-2 aisle width | stalls + aisle direction |
| §9 Table 9-5 throat storage length | lot lines, stalls, left-turn flag, land use group |
| §7 Table 7-4 driveways per frontage | lot lines + street frontage |
| §7 Table 7-5 driveway spacing | frontage, Street Level, class |
| §9.3.2.B compact ≤ 30% | stalls + required parking count |
| §9.3.2.O bay ≤ 200 ft or 20 stalls | stalls |

## 4. Out of scope — say so explicitly

Declaring these keeps the tool honest about what it does not check:

- **Driveway grades** (Table 7-3) — 3D, out of scope by the original spec
- **Queuing / drive-through** (§9.3.4.1) — needs ITE trip generation, not geometry
- **Bicycle and dockless parking** (§9.8, §9.9) — different domain
- **Shared parking / TDM** (§9.5) — an analysis, not a drawing check
- **On-street parking and loading** (§9.2, §9.4.2) — inside the ROW, not our footprint
- **Required parking counts** — set by the LDC, not the TCM

## 5. Open questions on the stall input

1. **Angle** — derive from each stall rectangle's orientation relative to its
   adjacent aisle rather than asking for it. Table 9-2 is keyed to 30/45/60/75/90.
2. **Standard vs compact** — derive from width: 8'-6" standard, 7'-6" compact. A
   stall drawn at 8'-0" is neither, which is a genuine FAIL rather than a
   classification problem.
3. **Accessible stalls must be flagged.** They follow PROWAG/TAS dimensions, not
   Table 9-2, and would otherwise be reported as undersized standard stalls —
   a false failure, the worst kind of output for a QC tool.
4. **Association to an aisle** — derive by adjacency; each stall's open side
   faces one.
5. **How are stalls handed in?** A named layer or a dedicated GH pin. A pin is
   preferable: explicit, and it keeps the tool from sniffing layer names, which
   is the fragile-metadata problem the project was built to avoid.
