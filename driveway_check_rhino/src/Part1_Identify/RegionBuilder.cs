using System.Collections.Generic;
using System.Linq;
using Rhino.Geometry;
using NetTopologySuite.Geometries;
using NetTopologySuite.Geometries.Prepared;
using NetTopologySuite.Noding.Snapround;
using NetTopologySuite.Operation.Polygonize;
using DrivewayChecker.Identify.Core;

namespace DrivewayChecker.Identify
{
    // One identified region of the footprint: what it is, and the paving it
    // occupies. This is Part 1's real output. The tags in SkeletonPreview are
    // a rendering of it, and Part 2 measures it.
    //
    // Face is the region on the BRIDGED footprint -- the shape as analysed,
    // with any median filled in. Lanes are the REAL paving inside that face,
    // which is what may be measured: normally one, and two when a median
    // divides a drive. Run is the skeleton run that owns the face and carries
    // its width profile; it is null for an apron, which is recognised from the
    // boundary arcs rather than from a run.
    public sealed record IdentifiedRegion(
        Category Category,
        Polygon Face,
        IReadOnlyList<Polygon> Lanes,
        ClassifiedRun Run);

    // Splits the footprint along the delineation lines and works out what each
    // resulting piece is. Extracted from SkeletonPreview so that identification
    // produces DATA rather than only labels -- Part 2 cannot measure a region
    // it was never handed, and the faces were previously local variables that
    // went out of scope as soon as their tag text had been built.
    public static class RegionBuilder
    {
        // Snapping grid for the noding below: 1e4 -> 0.0001ft cells. Coarse
        // enough to swallow floating-point noise at real site coordinates, fine
        // enough to be far below any real feature. Results are identical
        // anywhere in the 1e2..1e6 range, so this isn't calibrated to a shape.
        public const double SnapGridScale = 1e4;

        // Faces are polygonized from the BRIDGED footprint, and the real paving
        // is intersected back out of each one afterwards. Doing it the other
        // way round -- polygonizing the real paving directly -- runs the apron
        // cut straight through the median TIP, and since a designer ends the
        // median exactly where the apron mouth begins (measured identical to
        // four decimals on the real drive) the flare ring cannot close: at -20
        // degrees the entire flare face vanished and went untagged, while the
        // other seven rotations happened to survive. That is the
        // noding-robustness signature from the hard-won lessons, and the answer
        // is to remove the degeneracy rather than nudge the geometry. The
        // bridged footprint has no void for a cut to pinch against, so the
        // topology is plain.
        public static List<IdentifiedRegion> Build(
            SkeletonGraph graph,
            Polygon analysis,
            Polygon paving,
            List<ClassifiedRun> runs,
            List<ApronFinder.Apron> aprons,
            List<Line> delineation_lines)
        {
            var gf = analysis.Factory;
            var geoms = new List<Geometry> { analysis.Boundary };
            foreach (var d in delineation_lines)
                geoms.Add(gf.CreateLineString(new[] { new Coordinate(d.From.X, d.From.Y), new Coordinate(d.To.X, d.To.Y) }));

            // Snap-rounded noding, NOT a plain Union(): a cut endpoint is
            // computed to land on the boundary, and at floating precision it
            // lands "on" it only to within a few bits. Union then
            // intermittently fails to node there and Polygonizer silently
            // returns fewer faces -- a rotated T-shape gave 1-4 faces depending
            // on rotation, and nudging the cut length changed the answer
            // non-monotonically (0.001ft overshoot -> 3 faces, 0.01 -> 2, 0.1
            // -> 3, 1.0 -> 4), which is the signature of a robustness failure
            // rather than anything geometric. Snap-rounding to a fixed grid
            // makes the noding exact, and is what NTS provides for precisely
            // this. Verified stable for grids from 0.01ft to 1e-6ft, so the
            // exact scale is not a tuned magic number.
            var polygonizer = new Polygonizer();
            foreach (var noded in new GeometryNoder(new PrecisionModel(SnapGridScale)).Node(geoms))
                polygonizer.Add(noded);

            var regions = new List<IdentifiedRegion>();
            foreach (Polygon face in polygonizer.GetPolygons().Cast<Polygon>())
            {
                // Which run midpoint lands in this face. NOTE: only
                // well-defined while each face holds one run -- if a cut is
                // missing, a face holds several and this picks by list order.
                // Tried breaking that tie by node count and it made things
                // worse (a staple crossbar+leg face went Lot -> Drive, because
                // a long thin leg carries more nodes than the wider crossbar),
                // so it is deliberately left alone.
                var prepared = PreparedGeometryFactory.Prepare(face);

                Category category;
                ClassifiedRun owning_run = null;

                // An apron is recognised by geometry, not by a run label, so it
                // is checked first: the run whose spine passes through an apron
                // belongs to the drive, and would otherwise label it DRIVE.
                if (aprons.Any(a => prepared.Contains(gf.CreatePoint(a.Inside))))
                {
                    category = Category.Apron;
                }
                else
                {
                    owning_run = runs.FirstOrDefault(r =>
                        prepared.Contains(gf.CreatePoint(graph.Nodes[r.NodeIndices[r.NodeIndices.Count / 2]])));

                    // Fallback: the run holding the most of this face. Needed
                    // once apron cuts exist, because they come from the
                    // boundary fillets rather than from a run boundary, so an
                    // apron cut slices a drive run in two -- the run midpoint
                    // lands in only one half and the other used to be dropped
                    // untagged (measured: a flared drive reported APRON alone,
                    // losing its DRIVE entirely). Kept strictly as a fallback:
                    // making it the PRIMARY rule regressed the staple, since a
                    // long thin leg outnumbers a wider crossbar on node count.
                    owning_run ??= runs
                        .Select(r => (Run: r, Inside: r.NodeIndices.Count(n => prepared.Contains(gf.CreatePoint(graph.Nodes[n])))))
                        .Where(x => x.Inside > 0)
                        .OrderByDescending(x => x.Inside)
                        .Select(x => x.Run)
                        .FirstOrDefault();
                    if (owning_run == null) continue; // a face no run reaches at all
                    category = owning_run.Category;
                }

                // Back to real paving. Intersecting with the actual surface,
                // rather than subtracting the median polygon, because the
                // bridge and the median are not bit-identical complements of
                // each other: subtracting left a hair-thin isthmus at some
                // rotations and the two lanes came back as one piece. The
                // intersection asks the question that actually matters -- which
                // part of this face is driveable -- and cannot leave one.
                var surface = face.Intersection(paving);

                var lanes = new List<Polygon>();
                for (int i = 0; i < surface.NumGeometries; i++)
                    if (surface.GetGeometryN(i) is Polygon lane && !lane.IsEmpty && lane.Area > 0)
                        lanes.Add(lane);
                if (lanes.Count == 0) continue;

                regions.Add(new IdentifiedRegion(category, face, lanes, owning_run));
            }
            return regions;
        }
    }
}
