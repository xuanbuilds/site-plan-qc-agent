// The control flow: Part 1 identify -> Part 2 measure -> Part 3 check.
//
// This "Script Input Parameter" mode runs top-level statements, not a
// RunScript method -- input/output pin names are ambient variables directly
// (confirmed live: Console.WriteLine, not Print, writes to "out").
// S's type hint must be Brep or Geometry, NOT Surface -- see the note on
// IdentifyRun.Analyze. A Surface hint silently drops the trim boundary and
// every shape reads as its bounding rectangle, so the cast below fails loud
// instead of analyzing the wrong shape.
// C's Data Access is List (a site can have more than one road) -- it arrives
// as some IEnumerable of Curve, not necessarily List<Curve> exactly, hence
// Cast<Curve>() rather than a direct cast.
// Outputs: out, edges, tag_planes, tag_texts, delineation_lines.
try
{
    Console.WriteLine("start");
    var drive = S as Brep;
    if (drive == null && S is Surface)
        throw new ArgumentException(
            "S arrived as a Surface, which cannot carry a trim boundary -- an L/T/staple footprint " +
            "would be analyzed as its untrimmed bounding rectangle. Set the S input's type hint to Brep (or Geometry).");
    if (drive == null)
        throw new ArgumentException($"S must be a Brep; got {S?.GetType().Name ?? "null"}.");

    var road_centerlines = (C as System.Collections.IEnumerable)?.Cast<Curve>().ToList() ?? new List<Curve>();

    // ---- Part 1: what is each piece of paving? ----
    var result = DrivewayChecker.Identify.IdentifyRun.Analyze(drive, road_centerlines, regulations as string);
    double z = drive.Faces[0].OuterLoop.To3dCurve().PointAtStart.Z;
    var preview = DrivewayChecker.Identify.SkeletonPreview.Build(
        result.Graph, result.Profile, result.Analysis, result.Polygon, result.Arcs, result.Runs, z);

    // ---- Part 2: how big is it? ----
    var sizes = DrivewayChecker.Dimensions.DimensionRun.RegionSizes(preview.Regions, result.Profile);
    var radii = DrivewayChecker.Dimensions.DimensionRun.ConnectionRadii(preview.Regions, result.Arcs);

    // ---- Part 3: does it pass? ---- not written yet.

    // The size belongs on the region's own tag rather than beside it, so a
    // region reads as one label: DRIVE (L = 60.1 / W = 12.0).
    // SkeletonPreview.TagRegions
    // emits exactly one tag per region, in region order, which is what lets
    // these two lists be walked together.
    var size_by_region = sizes.ToDictionary(d => d.Region, d => d.Text);
    var tag_planes_out = new List<Plane>();
    var tag_texts_out = new List<string>();
    for (int i = 0; i < preview.Tags.Count; i++)
    {
        var text = preview.Tags[i].Text;
        if (i < preview.Regions.Count && size_by_region.TryGetValue(preview.Regions[i], out var measured))
            text += $" ({measured})";
        tag_planes_out.Add(preview.Tags[i].Location);
        tag_texts_out.Add(text);
    }

    // Connection radii get their own tags -- they sit on the boundary between
    // two regions rather than inside either one, so they have no region label
    // to join.
    foreach (var radius in radii)
    {
        tag_planes_out.Add(new Plane(new Point3d(radius.At.X, radius.At.Y, z), Vector3d.ZAxis));
        tag_texts_out.Add(radius.Text);
    }

    edges = preview.Edges;
    tag_planes = tag_planes_out;
    tag_texts = tag_texts_out;
    delineation_lines = preview.DelineationLines;
    Console.WriteLine($"done, edges={preview.Edges.Count} regions={preview.Regions.Count} " +
                      $"sizes={sizes.Count} radii={radii.Count} tags={tag_texts_out.Count}");
}
catch (Exception ex)
{
    Console.WriteLine("ERROR: " + ex);
}
