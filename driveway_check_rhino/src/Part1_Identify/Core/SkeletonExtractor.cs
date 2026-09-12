using System;
using System.Collections.Generic;
using NetTopologySuite.Geometries;
using NetTopologySuite.Geometries.Prepared;
using NetTopologySuite.Triangulate;

namespace DrivewayChecker.Identify.Core
{
    // Approximate medial axis (skeleton) extraction for a 2D polygon footprint.
    //
    // No RhinoCommon dependency by design -- operates on plain NTS Polygon/Coordinate
    // types, so it can be developed and tested standalone via `run_csharp` against
    // synthetic shapes, with no Rhino round-trip needed. Ported from
    // reference/core/skeleton.py, same method:
    //   1. Densely sample the polygon boundary (exterior + holes) into points.
    //   2. Compute the Voronoi diagram of those boundary points.
    //   3. Keep only edges whose both endpoints fall strictly inside the polygon.
    //      What survives approximates the medial axis.
    //
    // NTS has no direct scipy-Voronoi-style ridge-vertex output, so edges are
    // recovered from VoronoiDiagramBuilder's per-site cell polygons instead: every
    // internal Voronoi edge is shared by exactly two adjacent cells' boundary rings,
    // so collecting+deduping ring segments across all cells reconstructs the same
    // ridge graph scipy would hand back directly (verified live against NTS 2.5.0).
    //
    // Known limitation (not yet solved by extraction alone): raw output is noisy --
    // every reflex (concave) vertex of the input polygon produces a spurious short
    // branch toward it. See SkeletonPruning.
    public static class SkeletonExtractor
    {
        public static SkeletonGraph ExtractSkeleton(Polygon polygon, double sampleSpacing)
        {
            var gf = polygon.Factory;

            // NTS's classic overlay algorithm can throw TopologyException:
            // found non-noded intersection for certain sample-point
            // configurations -- a numerical degeneracy in the underlying
            // Delaunay triangulation, not a flaw in the input shape (found on
            // a real "staple"-shaped footprint with two close reflex
            // corners). VoronoiDiagramBuilder.Tolerance does NOT fix this --
            // tried the full range from 0.001 to 1.0, all failed identically.
            // A pure spacing-scale change isn't reliable on its own either:
            // found a real building footprint (a T-shape with a two-legged
            // notch) that still failed on every attempt up to a 5% spacing
            // change, because that scale change alone can preserve an exact
            // coincidence between two independently-sampled points on a
            // shape with round, symmetric proportions -- scaling everything
            // uniformly doesn't break that symmetry. Adding a small random
            // jitter to each sampled point (once spacing alone hasn't
            // worked) does break it, since it perturbs points independently
            // rather than as a group.
            const int maxAttempts = 12;
            var jitterRandom = new Random(12345);
            List<Coordinate> boundaryPts = null;
            GeometryCollection diagram = null;
            for (int attempt = 0; attempt < maxAttempts; attempt++)
            {
                boundaryPts = SampleBoundary(polygon, sampleSpacing * Math.Pow(1.0123, attempt));
                if (attempt > 0)
                {
                    double jitter = sampleSpacing * 1e-4;
                    for (int k = 0; k < boundaryPts.Count; k++)
                        boundaryPts[k] = new Coordinate(
                            boundaryPts[k].X + (jitterRandom.NextDouble() - 0.5) * jitter,
                            boundaryPts[k].Y + (jitterRandom.NextDouble() - 0.5) * jitter);
                }
                try
                {
                    var vb = new VoronoiDiagramBuilder();
                    vb.SetSites(boundaryPts);
                    diagram = vb.GetDiagram(gf);
                    break;
                }
                catch (TopologyException) when (attempt < maxAttempts - 1)
                {
                }
            }

            var prepared = PreparedGeometryFactory.Prepare(polygon);

            var nodeIndex = new Dictionary<(long, long), int>();
            var nodes = new List<Coordinate>();
            var edgeSet = new HashSet<(int, int)>();
            var edges = new List<(int, int)>();

            int GetOrAddNode(Coordinate c)
            {
                var key = Quantize(c);
                if (nodeIndex.TryGetValue(key, out var idx)) return idx;
                idx = nodes.Count;
                nodes.Add(c);
                nodeIndex[key] = idx;
                return idx;
            }

            for (int gi = 0; gi < diagram.NumGeometries; gi++)
            {
                if (diagram.GetGeometryN(gi) is not Polygon cell) continue;
                var ring = cell.ExteriorRing.Coordinates;
                for (int i = 0; i + 1 < ring.Length; i++)
                {
                    var c1 = ring[i];
                    var c2 = ring[i + 1];
                    if (!prepared.Contains(gf.CreatePoint(c1)) || !prepared.Contains(gf.CreatePoint(c2)))
                        continue; // discard: touches the clip envelope or falls outside the footprint

                    int i1 = GetOrAddNode(c1);
                    int i2 = GetOrAddNode(c2);
                    if (i1 == i2) continue;
                    var key = i1 < i2 ? (i1, i2) : (i2, i1);
                    if (edgeSet.Add(key)) edges.Add(key);
                }
            }

            return new SkeletonGraph(nodes, edges);
        }

        static (long, long) Quantize(Coordinate c, double precision = 1e-6)
            => ((long)Math.Round(c.X / precision), (long)Math.Round(c.Y / precision));

        static List<Coordinate> SampleBoundary(Polygon polygon, double spacing)
        {
            var pts = new List<Coordinate>();
            SampleRing(polygon.ExteriorRing, spacing, pts);
            foreach (var hole in polygon.InteriorRings)
                SampleRing(hole, spacing, pts);
            return pts;
        }

        // Evenly spaced samples along one ring, same `max(n, 8)` floor as the
        // Python prototype's _sample_boundary.
        static void SampleRing(LineString ring, double spacing, List<Coordinate> outPts)
        {
            double length = ring.Length;
            int n = Math.Max((int)(length / spacing), 8);
            var coords = ring.Coordinates;

            var cumulative = new double[coords.Length];
            for (int i = 1; i < coords.Length; i++)
                cumulative[i] = cumulative[i - 1] + Dist(coords[i - 1], coords[i]);

            for (int i = 0; i < n; i++)
                outPts.Add(PointAtLength(coords, cumulative, length * i / n));
        }

        static Coordinate PointAtLength(Coordinate[] coords, double[] cumulative, double target)
        {
            int i = Array.BinarySearch(cumulative, target);
            if (i < 0) i = ~i;
            i = Math.Clamp(i, 1, coords.Length - 1);

            double segLen = cumulative[i] - cumulative[i - 1];
            double t = segLen > 1e-12 ? (target - cumulative[i - 1]) / segLen : 0.0;
            double x = coords[i - 1].X + t * (coords[i].X - coords[i - 1].X);
            double y = coords[i - 1].Y + t * (coords[i].Y - coords[i - 1].Y);
            return new Coordinate(x, y);
        }

        static double Dist(Coordinate a, Coordinate b)
        {
            double dx = a.X - b.X, dy = a.Y - b.Y;
            return Math.Sqrt(dx * dx + dy * dy);
        }
    }
}
