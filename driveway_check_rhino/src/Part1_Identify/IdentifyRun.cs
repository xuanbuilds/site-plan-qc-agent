using System.Collections.Generic;
using Rhino.Geometry;
using NetTopologySuite.Geometries;
using DrivewayChecker.Identify.Core;
// BrepToPolygon lives in Shared with the other Rhino <-> NTS plumbing
using DrivewayChecker.Shared;

namespace DrivewayChecker.Identify
{
    // The tool's three inputs, going forward:
    //   1. drive            -- the paved footprint to analyze. Must be a
    //                           Brep, NOT a Surface: a Surface cannot carry
    //                           a trim boundary, so an L/T/staple footprint
    //                           casts down to its untrimmed bounding
    //                           rectangle (measured: a 1520 sq ft L-shape
    //                           became a 3329 sq ft rectangle, 6 boundary
    //                           segments became 4). Everything downstream
    //                           then analyzes a rectangle -- one spine, one
    //                           run, one category, no delineation lines --
    //                           which looks like a broken classifier rather
    //                           than a lost input. Keep the GH pin's type
    //                           hint on Brep (or Geometry).
    //   2. road_centerlines -- a site can have more than one road, so this
    //                          is a list. Still accepted-but-unused in
    //                          classification for now (Classifier's
    //                          aspect-ratio rule replaced its previous use as
    //                          a drive-vs-lot tiebreaker) -- per-road
    //                          proximity classification (which narrow piece
    //                          belongs to which road) is a real next step,
    //                          not implemented yet.
    //   3. regs_folder_path -- placeholder, not used yet; no code checking is
    //                           implemented (LLM/rules pass comes later)
    public static class IdentifyRun
    {
        // Arcs travel alongside the polygon rather than being baked into it:
        // every NTS step needs the faceted polygon, while apron detection and
        // (later) turning-radius checks need the arcs as drawn. See BoundaryArc.
        // Polygon is the real paving -- what gets split, tagged and measured.
        // Analysis is the same footprint with any median bridged, and is what
        // the skeleton, the runs and the apron search were built from. They are
        // the same object when the drive has no median. Keeping both is the
        // point: a median must be invisible to the analysis and present in
        // every measurement.
        public record Result(Polygon Polygon, Polygon Analysis, IReadOnlyList<Polygon> Medians, IReadOnlyList<BoundaryArc> Arcs, SkeletonGraph Graph, WidthProfile Profile, List<ClassifiedRun> Runs);

        public static Result Analyze(
            Brep drive, List<Curve> road_centerlines = null, string regs_folder_path = null,
            double sample_spacing = 2.0, double run_tolerance = 3.0)
        {
            var gf = new GeometryFactory();

            var polygon = BrepToPolygon.Convert(drive, gf);
            var arcs = BrepArcs.Extract(drive);

            // Bridging comes first: a median splits one drive's spine in two
            // and blinds the apron search, so everything after this point works
            // on the bridged footprint. The real paving is carried alongside.
            var medians = MedianFinder.Find(polygon);
            var analysis = MedianFinder.Bridge(polygon, medians);

            var graph = SkeletonExtractor.ExtractSkeleton(analysis, sample_spacing);
            var profile = WidthProfile.Compute(analysis, graph);
            var pruned = SkeletonPruning.Prune(graph, profile);
            var runs = RunSegmenter.ConstantWidthRuns(pruned.Graph, pruned.Profile, run_tolerance);
            var classified = Classifier.ClassifyRuns(pruned.Graph, pruned.Profile, runs);

            return new Result(polygon, analysis, medians, arcs, pruned.Graph, pruned.Profile, classified);
        }
    }
}
