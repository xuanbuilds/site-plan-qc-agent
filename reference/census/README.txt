WHAT IS IN HERE, AND WHICH PARTS ARE STILL TRUE
===============================================

These are headless runs of the checker over the whole corpus in
reference/test SVG/, one row per plan. They are dated snapshots, not live
results.

READ THIS FIRST
---------------
census-2026-09-12.csv was run while an experimental scale estimator was in
the code. That estimator guessed a plan's scale by assuming every parking
stall is 9 ft wide. It has since been REMOVED, because a guessed scale
produces confident, wrong measurements that nobody can see are wrong. Scale
now comes only from the file declaring it (data-px-per-ft) or from the user
clicking two points.

So in census-2026-09-12.csv:

  STILL TRUE - anything that does not depend on scale
    name, style, viewBox, declared, method, candidates, tag_is_top,
    top_margin, stage='read', and the identify errors themselves.
    36 rows have scale_source='declared'; everything in those rows is real.

  NOT TRUE - anything measured in feet on the 303 rows where
    scale_source='estimated'. Every width, length, area and region outcome
    on those rows was computed from a guessed scale. That includes the
    "114 plans produced no DRIVE region" figure: only 5 of those 114 had a
    scale the file actually declared.

  The 154 rows with scale_source='none' never ran at all.

THE FILES
---------
files.json                            the corpus list the runs iterate over
census-2026-09-12.csv                 full run; see the caveat above
summary-2026-09-12.json               its aggregates; same caveat
ranker-2026-09-13.csv                 which shape the fallback ranker picks,
                                      before and after the scoring fix.
                                      Scale-independent, fully valid.
dimension-text-scale-2026-09-13.csv   the scale each plan states in its own
                                      dimension strings (24'-0" beside a
                                      dimension line), read directly. This is
                                      the file stating a number, not a guess,
                                      so it is a legitimate future source -
                                      unlike the estimator. 207 plans carry
                                      two or more agreeing readings.
renamed-2026-09-13.csv                filename tags added to the corpus:
                                      _drive_not_found (43 plans with no
                                      shape in the drive colour) and
                                      _drive_not_classified (5 plans that
                                      identified under a declared scale and
                                      still produced no DRIVE region).

RE-RUNNING
----------
The numbers above are only reproducible for plans that declare a scale, which
is 35 of 493. A full re-run needs a scale per plan supplied by a human.
