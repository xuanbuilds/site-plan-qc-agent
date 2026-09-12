"""
Zone labels -> tagged Rhino objects. RhinoCommon-dependent.

NOT YET IMPLEMENTED. Same reasoning as extract.py — waiting on a real
target brep before committing to an implementation.

Intended shape:

    def apply_zone_labels(doc, classified_runs, source_brep_id):
        '''
        Given classified skeleton runs (core.classify.ClassifiedRun),
        create visual/queryable evidence in the live Rhino doc:
        - one curve per run, colored/layered by zone
          (drive_strip / maneuvering / stall_bay / turnaround / unknown)
        - each curve's object Name or UserText carries avg_width and
          `reason`, so a human reviewing the QC output can see *why*
          a segment was classified as it was -- audit trail, not a
          black box
        '''
        raise NotImplementedError
"""
