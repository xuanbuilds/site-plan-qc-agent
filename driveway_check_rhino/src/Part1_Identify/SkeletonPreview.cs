using System;
using System.Collections.Generic;
using System.Linq;
using Rhino.Geometry;
using NetTopologySuite.Geometries;
using DrivewayChecker.Identify.Core;

namespace DrivewayChecker.Identify
{
    // Builds GH-preview-ready geometry from a classification result: skeleton
    // edges (internal-analysis only), a delineation line at each boundary
    // between differently-categorized runs, and one text tag per REAL split
    // surface -- not per skeleton run, see TagRealFaces below. No color --
    // the tag text alone communicates which is which. GH-preview-only by
    // design -- nothing here bakes into the Rhino document.
    public static class SkeletonPreview
    {
        public record Tag(Plane Location, string Text);
        // Regions are the real output of identification; Tags are a
        // rendering of them. Part 2 measures Regions, not Tags.
        public record Result(List<Line> Edges, List<Tag> Tags, List<Line> DelineationLines, List<IdentifiedRegion> Regions);

        // analysis = the footprint with its medians bridged, which is what the
        // skeleton, the runs and the arcs all describe, so cuts and aprons are
        // found on it. paving = the real surface, which every face is trimmed
        // back to before it is tagged, so each travel lane stays its own real
        // region and no unpaved ground is ever counted as drive.
        public static Result Build(SkeletonGraph graph, WidthProfile profile, Polygon analysis, Polygon paving, IReadOnlyList<BoundaryArc> arcs, List<ClassifiedRun> runs, double z)
        {
            var edges = new List<Line>();
            foreach (var run in runs)
            {
                for (int i = 0; i + 1 < run.NodeIndices.Count; i++)
                {
                    var a = graph.Nodes[run.NodeIndices[i]];
                    var b = graph.Nodes[run.NodeIndices[i + 1]];
                    edges.Add(new Line(ToPoint3d(a, z), ToPoint3d(b, z)));
                }
            }

            // An apron's cut comes from its own fillet tangent points rather
            // than from a Drive/Lot run boundary, but it is a delineation line
            // like any other -- it splits the footprint, and the face beyond it
            // is a measurable region.
            var aprons = ApronFinder.Find(analysis, arcs, graph, profile);
            var delineation_lines = BuildDelineationLines(graph, profile, analysis, runs, z);
            foreach (var apron in aprons)
            {
                // The run-boundary pass finds this same throat on its own --
                // the flare IS a width transition -- but it sizes the cut from
                // the drive's own side walls, while the mouth spans the
                // fillets' tangent points. Those agree only when the two
                // fillets are symmetric. On the user's flared drive they are
                // not (r=7.27 against r=13.76): the wall-anchored cut came out
                // 18.00ft square to the drive, the mouth 18.92ft, sharing one
                // end and splaying 5.6ft apart at the other -- far too wide a
                // gap for SameCut, so both survived and the sliver between them
                // became its own face carrying a spurious DRIVE tag. Two cuts
                // that meet inside the paving are describing one transition,
                // and the mouth is the definitional one (the tangent points ARE
                // where the apron starts), so the derived cut gives way to it.
                var mouth = new Line(ToPoint3d(apron.MouthA, z), ToPoint3d(apron.MouthB, z));
                delineation_lines.RemoveAll(existing => SameCut(existing, mouth) || Crosses(existing, mouth));
                delineation_lines.Add(mouth);
            }

            var regions = RegionBuilder.Build(graph, analysis, paving, runs, aprons, delineation_lines);
            return new Result(edges, TagRegions(regions, z), delineation_lines, regions);
        }

        // A physical Lot's own medial axis is a small tree, not a single
        // line -- it forks once for every Drive that connects to it -- so
        // one real Lot routinely shows up as 2+ separate skeleton runs, each
        // independently classified. Tagging per run then means one real
        // surface gets two "Lot" labels, which isn't a labeling bug so much
        // as tagging the wrong thing: the skeleton is fictional (a computed
        // aid), the footprint split by the actual delineation lines is real.
        // Splitting the polygon along those lines and tagging each resulting
        // face fixes this directly -- two adjacent same-category runs with no
        // delineation line between them land in the same face automatically,
        // so no separate "merge adjacent faces" step is needed on top.
        // One tag per region, not per lane. A median splits a drive into two
        // strips geometrically, but it is still one drive, so it is labelled
        // once and labelled DRIVE like any other.
        //
        // Anchored on the largest lane so the text lands on real paving
        // instead of on the grass down the middle. An undivided region has
        // exactly one lane, so this is the same point it always was.
        static List<Tag> TagRegions(List<IdentifiedRegion> regions, double z)
        {
            var tags = new List<Tag>();
            foreach (var region in regions)
            {
                var anchor = region.Lanes.OrderByDescending(lane => lane.Area).First();
                tags.Add(new Tag(new Plane(ToPoint3d(anchor.Centroid.Coordinate, z), Vector3d.ZAxis), Label(region.Category)));
            }
            return tags;
        }


        // The cut comes from the footprint's own edges, using the skeleton only
        // to know which way the drive runs. A drive is a strip: its two side
        // walls are the boundary edges parallel to its axis, nearest the spine
        // on either side. Each wall's far end -- its last point before the
        // footprint opens out -- is where the drive stops being a drive, and
        // that's true whether the junction is a sharp corner (the corner
        // vertex itself) or filleted (the arc's tangent point, which IS the
        // straight wall's endpoint, so no arc-specific handling is needed).
        // Cut at whichever of the two wall-ends comes first, perpendicular,
        // across to the opposite wall.
        //
        // Nothing here searches outward by distance or compares widths against
        // a tolerance, which is what broke earlier attempts: sizing from the
        // skeleton's local width produced diagonal cuts through the flare, and
        // searching outward from the spine could reach clean past a real gap
        // onto an unrelated wall on shapes with two features close together.
        static List<Line> BuildDelineationLines(SkeletonGraph graph, WidthProfile profile, Polygon polygon, List<ClassifiedRun> runs, double z)
        {
            var lines = new List<Line>();
            var seenNodes = new HashSet<int>();
            var boundary = polygon.ExteriorRing.Coordinates;

            for (int i = 0; i < runs.Count; i++)
            {
                for (int j = i + 1; j < runs.Count; j++)
                {
                    if (runs[i].Category == runs[j].Category) continue;

                    var driveRun = runs[i].Category == Category.Drive ? runs[i] : runs[j];
                    var otherRun = runs[i].Category == Category.Drive ? runs[j] : runs[i];

                    int? junction = JunctionNode(graph, driveRun.NodeIndices, otherRun.NodeIndices);
                    if (junction == null || !seenNodes.Add(junction.Value)) continue;

                    var line = DelineationLineAt(graph, profile, boundary, driveRun.NodeIndices, junction.Value, z);
                    if (line.HasValue) lines.Add(line.Value);
                }
            }
            return lines;
        }

        static Line? DelineationLineAt(SkeletonGraph graph, WidthProfile profile, Coordinate[] boundary, List<int> driveNodeIndices, int junctionNode, double z)
        {
            // whichever of the drive run's two ends lies farther from the
            // junction -- the junction is no longer guaranteed to BE one of
            // them (see JunctionNode), so an index comparison won't do
            var jCoord = graph.Nodes[junctionNode];
            double DistToJunction(int node)
            {
                var c = graph.Nodes[node];
                return (c.X - jCoord.X) * (c.X - jCoord.X) + (c.Y - jCoord.Y) * (c.Y - jCoord.Y);
            }
            int farEndNode = DistToJunction(driveNodeIndices[0]) >= DistToJunction(driveNodeIndices[^1])
                ? driveNodeIndices[0]
                : driveNodeIndices[^1];
            var farCoord = graph.Nodes[farEndNode];

            double dx = jCoord.X - farCoord.X, dy = jCoord.Y - farCoord.Y;
            double axisLen = Math.Sqrt(dx * dx + dy * dy);
            if (axisLen < 1e-9) return null; // junction and far end coincide -- no axis to work from
            double dirX = dx / axisLen, dirY = dy / axisLen;
            double perpX = -dirY, perpY = dirX;

            // signed perpendicular offset and along-axis position, both
            // measured from the junction
            double Offset(Coordinate c) => (c.X - jCoord.X) * perpX + (c.Y - jCoord.Y) * perpY;
            double Along(Coordinate c) => (c.X - jCoord.X) * dirX + (c.Y - jCoord.Y) * dirY;

            // Only walls that reach this junction are candidates. One local
            // width is the natural span: the drive's own side walls at a
            // junction either cross it or stop just short of it, while
            // anything a whole width further along belongs to some other part
            // of the drive.
            double reach = profile.NodeWidth[junctionNode];
            var wallPos = NearestParallelWall(boundary, dirX, dirY, Offset, Along, reach, positiveSide: true);
            var wallNeg = NearestParallelWall(boundary, dirX, dirY, Offset, Along, reach, positiveSide: false);
            if (wallPos == null || wallNeg == null) return null;

            var endPos = WallEndTowardJunction(wallPos.Value, Along);
            var endNeg = WallEndTowardJunction(wallNeg.Value, Along);

            // whichever wall ends first (further back from the junction) sets
            // the cut's cross-section -- past that point the footprint has
            // already opened out on at least one side
            bool posEndsFirst = Along(endPos) <= Along(endNeg);
            var anchor = posEndsFirst ? endPos : endNeg;
            var anchorWall = posEndsFirst ? wallPos.Value : wallNeg.Value;
            var oppositeWall = posEndsFirst ? wallNeg.Value : wallPos.Value;

            // square the cut to the anchor wall itself, not to the skeleton
            // axis used to find the walls: the skeleton's own nodes zigzag by
            // hundredths of a foot, which is invisible in a direction test but
            // enough to tilt a 12ft cut a few inches out of square.
            double wx = anchorWall.B.X - anchorWall.A.X, wy = anchorWall.B.Y - anchorWall.A.Y;
            double wallLen = Math.Sqrt(wx * wx + wy * wy);
            double cutX = -wy / wallLen, cutY = wx / wallLen;

            var hit = IntersectWithWall(anchor, cutX, cutY, oppositeWall);
            if (hit == null) return null;

            return new Line(ToPoint3d(anchor, z), ToPoint3d(hit, z));
        }

        // The boundary edge running parallel to the drive's axis that sits
        // closest to the spine on the requested side -- i.e. one of the
        // drive's own two side walls. The 2-degree window is facet noise
        // allowance, not a tuned threshold: BrepToPolygon facets curves at 1
        // degree, so the first facet past a fillet's tangent point also reads
        // as near-parallel. It loses to the true straight wall anyway, since
        // an arc curves away from the spine, never toward it.
        // ...and it has to be a wall AT THIS JUNCTION, which is what `reach`
        // enforces. Ranking on perpendicular offset alone is not enough: a
        // faceted flare 120ft away down at the apron throws off dozens of
        // 0.11ft edges that are also parallel, and one of them sat 8.89ft from
        // the spine against the real wall's 9.82ft. It won, the cut was built
        // at the apron instead of the junction, and was then removed for
        // crossing the apron mouth -- so a drive running into a parking block
        // produced no cut at all and the two merged into one DRIVE region with
        // the LOT lost entirely. Measured on the user's curved drive.
        static (Coordinate A, Coordinate B)? NearestParallelWall(
            Coordinate[] boundary, double dirX, double dirY,
            Func<Coordinate, double> offset, Func<Coordinate, double> along, double reach, bool positiveSide)
        {
            const double parallelCos = 0.99939; // cos(2 degrees)
            (Coordinate, Coordinate)? best = null;
            double bestOffset = double.MaxValue;

            for (int i = 0; i + 1 < boundary.Length; i++)
            {
                var a = boundary[i];
                var b = boundary[i + 1];
                double ex = b.X - a.X, ey = b.Y - a.Y;
                double edgeLen = Math.Sqrt(ex * ex + ey * ey);
                if (edgeLen < 1e-9) continue;
                if (Math.Abs((ex * dirX + ey * dirY) / edgeLen) < parallelCos) continue;

                // how far this edge stops short of the junction along the
                // drive -- zero when it spans the junction outright
                double alongA = along(a), alongB = along(b);
                bool spans_junction = (alongA <= 0 && alongB >= 0) || (alongB <= 0 && alongA >= 0);
                double along_gap = spans_junction ? 0 : Math.Min(Math.Abs(alongA), Math.Abs(alongB));
                if (along_gap > reach) continue;

                double midOffset = (offset(a) + offset(b)) / 2.0;
                if (positiveSide ? midOffset <= 0 : midOffset >= 0) continue;

                double d = Math.Abs(midOffset);
                if (d < bestOffset) { bestOffset = d; best = (a, b); }
            }
            return best;
        }

        static Coordinate WallEndTowardJunction((Coordinate A, Coordinate B) wall, Func<Coordinate, double> along)
            => along(wall.A) >= along(wall.B) ? wall.A : wall.B;

        // where the cut line meets the opposite wall's own line (extended if
        // the walls end at different points along the axis, which is exactly
        // the asymmetric case this is here to handle)
        static Coordinate IntersectWithWall(Coordinate origin, double dirX, double dirY, (Coordinate A, Coordinate B) wall)
        {
            var (a, b) = wall;
            double ex = b.X - a.X, ey = b.Y - a.Y;
            double denom = dirX * ey - dirY * ex;
            if (Math.Abs(denom) < 1e-12) return null; // cut runs along the wall -- can't happen for a real side wall
            double t = ((a.X - origin.X) * ey - (a.Y - origin.Y) * ex) / denom;
            return new Coordinate(origin.X + t * dirX, origin.Y + t * dirY);
        }

        // Where two runs actually meet. RunSegmenter does NOT guarantee that
        // adjacent runs share one of their four end nodes: they can overlap on
        // interior nodes, or meet across a graph edge without sharing an index
        // at all. Measured on a pad-on-drive footprint whose Drive run ended
        // (9,90) while its Lot run ended (0,101) -- no shared end, so no cut
        // was produced, the whole footprint stayed one face, and a correctly
        // classified Lot was reported as Drive. Shared-end is still checked
        // first because it's the common case and fixes the junction exactly.
        static int? JunctionNode(SkeletonGraph graph, List<int> driveRun, List<int> otherRun)
        {
            var sharedEnd = SharedEndpoint(driveRun, otherRun);
            if (sharedEnd != null) return sharedEnd;

            var otherSet = new HashSet<int>(otherRun);
            var overlap = driveRun.Where(otherSet.Contains).ToList();
            if (overlap.Count > 0) return overlap[overlap.Count / 2];

            var driveSet = new HashSet<int>(driveRun);
            foreach (var (a, b) in graph.Edges)
            {
                if (driveSet.Contains(a) && otherSet.Contains(b)) return a;
                if (driveSet.Contains(b) && otherSet.Contains(a)) return b;
            }
            return null;
        }

        static int? SharedEndpoint(List<int> a, List<int> b)
        {
            var aEnds = new[] { a[0], a[^1] };
            var bEnds = new[] { b[0], b[^1] };
            foreach (var x in aEnds)
                foreach (var y in bEnds)
                    if (x == y) return x;
            return null;
        }

        // The run-boundary pass usually finds an apron's mouth already, since
        // the flare IS a width transition -- and the two methods agree on it
        // exactly, tangent point for tangent point. Adding a second identical
        // copy is not harmless: two coincident cuts cancel during noding and
        // the footprint stops splitting there at all (measured: one face for
        // the whole shape, so everything came back APRON). Either direction
        // counts as the same cut.
        const double SameCutTolerance = 0.05;

        // Whether two cuts meet anywhere along their lengths. Parallel and
        // collinear pairs report false, which is what SameCut is for -- this
        // catches the near-miss case that slips past it.
        static bool Crosses(Line a, Line b)
        {
            double ax = a.To.X - a.From.X, ay = a.To.Y - a.From.Y;
            double bx = b.To.X - b.From.X, by = b.To.Y - b.From.Y;
            double denom = ax * by - ay * bx;
            if (Math.Abs(denom) < 1e-12) return false;

            double wx = b.From.X - a.From.X, wy = b.From.Y - a.From.Y;
            double on_a = (wx * by - wy * bx) / denom;
            double on_b = (wx * ay - wy * ax) / denom;
            return on_a >= 0 && on_a <= 1 && on_b >= 0 && on_b <= 1;
        }

        static bool SameCut(Line a, Line b)
            => (a.From.DistanceTo(b.From) < SameCutTolerance && a.To.DistanceTo(b.To) < SameCutTolerance)
            || (a.From.DistanceTo(b.To) < SameCutTolerance && a.To.DistanceTo(b.From) < SameCutTolerance);

        // Tag text is upper case -- DRIVE / LOT / APRON. Derived from the enum
        // so the categories and the labels can't drift apart.
        static string Label(Category category) => category.ToString().ToUpperInvariant();

        static Point3d ToPoint3d(Coordinate c, double z) => new Point3d(c.X, c.Y, z);
    }
}
