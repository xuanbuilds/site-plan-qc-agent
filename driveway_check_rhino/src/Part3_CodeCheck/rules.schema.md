# Part 3 — Rule File Schema

The rule file is the boundary between reading the code and checking geometry.

**Claude is a compiler, not an interpreter.** It reads the transportation code
once, offline, and emits this file. At runtime C# only evaluates numbers against
rules — no LLM in the solve loop. That keeps every verdict deterministic,
reproducible, offline, and traceable to a citation, which is the whole reason
`reference/docs/approach.md` chose deterministic heuristics in the first place.

When the code is amended, re-extract and review a **diff**, not the whole file.

## Shape

```json
{
  "source": {
    "jurisdiction": "City of Austin",
    "document": "Transportation Criteria Manual",
    "edition": "<as printed on the document>",
    "retrieved": "2026-09-01",
    "file": "codes/austin-tcm.pdf"
  },
  "rules": [
    {
      "id": "tcm-7-5-driveway-width-sf",
      "applies_to": "DRIVE",
      "dimension": "drive_width",
      "conditions": { "land_use": "single_family" },
      "min_ft": 10,
      "max_ft": 20,
      "cite": {
        "section": "Table 7-5",
        "page": 0,
        "quote": "<verbatim text from the document>"
      },
      "confidence": "high",
      "needs_review": true,
      "notes": ""
    }
  ]
}
```

## Closed vocabularies

These are not free text. A rule naming anything outside them cannot be
evaluated and must fail loudly at load, not silently at check time.

**`applies_to`** — must match the `Category` enum exactly:
`DRIVE`, `LOT`, `APRON`.

**`dimension`** — must match a `Dimension.Kind` that Part 2 actually emits:
`drive_width`, `drive_length`, `lot_width`, `lot_length`, `connection_radius`.

> ⚠ Part 2 does not emit those five yet. It emits `drive_size` and `lot_size`,
> each carrying a single numeric `Value` (the width), with the length present
> only inside the display string. **A length rule therefore has nothing to check
> against.** First job of Part 3 is splitting those into one `Dimension` per
> measured quantity and letting the tag composer join them for display. The tag
> text does not change; only the data behind it.

**`confidence`** — `high` | `medium` | `low`. Anything below `high` must not be
checked until a human has reviewed it.

## Verdicts

`PASS` | `FAIL` | **`CANNOT_DETERMINE`**

The third one is not optional. Most real driveway standards are conditioned on
land use, street classification, and sometimes traffic volume — and this tool
reads shape and nothing else, by founding constraint. It cannot know that a site
is single-family or that the abutting street is a local road.

**Silently skipping a rule whose conditions can't be evaluated is how a checker
gives false confidence.** If a condition cannot be evaluated, the region reports
`CANNOT_DETERMINE` naming the missing input, and that shows in the Rhino tag
like any other verdict.

`conditions` keys must therefore be registered as either *supplied* (an input
the user provides per site) or *derived* (something geometry can establish).
Today almost none are derived. `road_centerlines` — accepted and unused since
the beginning — is the natural route to street classification.

## Citations are mandatory

Every rule carries `cite.quote`, the verbatim provision text. Two reasons:

1. **Audit.** A reviewing engineer must be able to check the tool's reading
   against the source without opening the PDF.
2. **Liability.** A QC tool reporting PASS against a misread provision is worse
   than no tool. `needs_review` starts `true` and is cleared by a human, not by
   the extractor.

## Order of work

1. Split Part 2's `drive_size` / `lot_size` into the five dimension kinds above.
2. Write 3–5 rules here BY HAND from provisions already known, and build the
   evaluator plus PASS / FAIL / CANNOT_DETERMINE tags against them.
3. Only then bulk-extract from the real document. By that point the schema is a
   contract, so it does not matter much who does the extracting.

Step 2 before step 3 deliberately: it proves the whole loop against a schema the
geometry is known to feed, so extraction has a concrete target rather than a
speculative one.

## Independent of the width accuracy fix?

Extraction is. **Checking is not.** Widths currently read ~0.04 ft low, so a
10 ft minimum checked against a measured 9.96 emits a false failure on compliant
geometry. Extraction and the wall-based measurement fix can proceed in parallel,
but no verdict should be shown to a user until the measurement is exact. See
`src/Part2_Dimensions/README.md`.
