"""
Brep -> polygon extraction. RhinoCommon-dependent — this is the only
layer that should be.

NOT YET IMPLEMENTED. Deliberately left as an interface stub until a
real target brep exists to test against — writing extraction logic
against a guessed geometry shape (rather than Cedar's actual pipeline
output) risks building the wrong thing.

Intended shape of this function, to run via the RhinoMCP run_python
tool against a live document (same execution surface already in use
this session):

    def extract_footprint_polygon(doc, brep_id) -> list[tuple[float,float]]:
        '''
        Given a brep's GUID in the live Rhino doc, return its footprint
        as a flat 2D boundary polygon (list of (x, y) points), suitable
        for core.skeleton.extract_skeleton().

        Real work here:
        - Get the brep by ID from doc.Objects
        - Project/flatten to the ground plane if not already planar
          (site plan footprints should be, but don't assume)
        - Walk the outer boundary loop, sample or extract its curve
          into a point list
        - Handle interior loops (holes) if the footprint has any
        - Return in the units the core pipeline expects (feet, to match
          the TCM tables) -- may need a unit-conversion step depending
          on the document's ModelUnitSystem, same issue as the earlier
          toilet-scaling problem
        '''
        raise NotImplementedError
"""
