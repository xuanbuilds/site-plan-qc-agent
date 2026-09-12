#r "C:\Users\XUANB\.nuget\packages\nettopologysuite\2.5.0\lib\netstandard2.0\NetTopologySuite.dll"

// GENERATED FILE -- do not edit. Regenerate with:
//   powershell -ExecutionPolicy Bypass -File tools\build_single_file.ps1
// Source of truth is src/; the GH entry point is src/GhEntryPoint.csx.

using DrivewayChecker.Identify.Core;
using DrivewayChecker.Identify;
using DrivewayChecker.Shared;
using Grasshopper.Kernel;
using NetTopologySuite.Algorithm;
using NetTopologySuite.Geometries.Prepared;
using NetTopologySuite.Geometries;
using NetTopologySuite.Noding.Snapround;
using NetTopologySuite.Operation.Buffer;
using NetTopologySuite.Operation.Polygonize;
using NetTopologySuite.Triangulate;
using Rhino.Geometry;
using Rhino;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System;

// ===== src/Part1_Identify/Core/SkeletonGraph.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Approximate medial axis, as a plain graph of NTS coordinates. No RhinoCommon
    // dependency -- ported from reference/core/skeleton.py's SkeletonGraph dataclass.
    public sealed class SkeletonGraph
    {
        public IReadOnlyList<Coordinate> Nodes { get; }
        public IReadOnlyList<(int A, int B)> Edges { get; }

        public SkeletonGraph(IReadOnlyList<Coordinate> nodes, IReadOnlyList<(int A, int B)> edges)
        {
            Nodes = nodes;
            Edges = edges;
        }

        public int[] ComputeDegrees()
        {
            var degrees = new int[Nodes.Count];
            foreach (var (a, b) in Edges)
            {
                degrees[a]++;
                degrees[b]++;
            }
            return degrees;
        }

        public int Degree(int nodeIndex)
        {
            int count = 0;
            foreach (var (a, b) in Edges)
                if (a == nodeIndex || b == nodeIndex) count++;
            return count;
        }

        // Nodes where the skeleton splits (degree >= 3) -- candidate boundaries
        // between functional zones (e.g. aisle meets stall).
        public List<int> BranchNodes()
        {
            var degrees = ComputeDegrees();
            return Enumerable.Range(0, Nodes.Count).Where(i => degrees[i] >= 3).ToList();
        }

        // Degree-1 nodes -- candidate drive-strip terminations (street connection)
        // or dead-end turnarounds.
        public List<int> EndpointNodes()
        {
            var degrees = ComputeDegrees();
            return Enumerable.Range(0, Nodes.Count).Where(i => degrees[i] == 1).ToList();
        }

        public Dictionary<int, List<int>> BuildAdjacency()
        {
            var adjacency = new Dictionary<int, List<int>>();
            for (int i = 0; i < Nodes.Count; i++) adjacency[i] = new List<int>();
            foreach (var (a, b) in Edges)
            {
                adjacency[a].Add(b);
                adjacency[b].Add(a);
            }
            return adjacency;
        }
    }
}

// ===== src/Part1_Identify/Core/BoundaryArc.cs =====
namespace DrivewayChecker.Identify.Core
{
    // A genuine arc in the footprint's outline, as it was actually drawn --
    // kept rather than faceted away with everything else.
    //
    // Two reasons it has to survive the Brep -> polygon conversion. First, a
    // filleted transition is the signal that distinguishes an apron (a drive
    // flaring out to meet the street) from a small lot, and its two tangent
    // points are exactly where the apron should be cut. Second, the radius
    // itself is what a turning-radius code check needs later -- once the
    // outline is faceted into straight segments that number is gone, and
    // re-fitting a circle to facets afterwards would only approximate a value
    // the model already states exactly.
    //
    // Start/End are the arc's tangent points (where it meets the straight
    // stretches on either side), which is what makes them useful as cut
    // anchors. No RhinoCommon dependency here by design -- plain NTS
    // coordinates, same as the rest of Core.
    public sealed record BoundaryArc(Coordinate Start, Coordinate End, Coordinate Center, double Radius)
    {
        public Coordinate Midpoint => new Coordinate((Start.X + End.X) / 2.0, (Start.Y + End.Y) / 2.0);

        // Straight-line distance across the arc, tangent point to tangent
        // point -- the width the flare actually opens up by on this side.
        public double ChordLength => Math.Sqrt(
            (End.X - Start.X) * (End.X - Start.X) + (End.Y - Start.Y) * (End.Y - Start.Y));
    }
}

// ===== src/Part1_Identify/Core/MedianFinder.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Finds landscape medians: the unpaved strip dividing one drive into two
    // travel lanes.
    //
    // A median is a void rather than paving, so nothing else in the pipeline
    // can see it -- and its absence breaks more than it appears to. On the
    // user's divided drive the two 8ft strips came out as two separate DRIVE
    // regions instead of one drive, AND the apron went undetected entirely:
    // the median's tip ends exactly where the apron mouth begins (measured
    // 0.002ft apart, which is correct design practice, not a drafting slip),
    // so the mouth crossed 2.13ft of grass and ApronFinder's SpansPaving
    // rejected it. Bridging the median fixes both at once, because everything
    // downstream then sees one continuous drive.
    //
    // What comes back is for ANALYSIS ONLY. Measurement and face tagging stay
    // on the real paving -- a median is not driveable surface and must never
    // enter a width or area check. See IdentifyRun.
    public static class MedianFinder
    {
        // Morphological closing: grow the paving by `reach`, then shrink it
        // back. Anything narrower than about 2*reach gets sealed shut on the
        // way out and does not reopen on the way back, so what survives the
        // round trip is exactly the set of gaps too narrow to be part of the
        // drive's own shape. Subtracting the original paving leaves the gaps
        // themselves.
        //
        // MITRE joins, not the default round ones, and this is the whole trick.
        // A round join cannot reproduce a sharp corner when it shrinks back, so
        // every concave corner in the footprint comes back as a small filled
        // wedge -- measured across the fixtures, seven false regions of 4 to 21
        // sq ft, which then need a size rule to tell them from a real median.
        // Mitre joins rebuild the corner exactly and those regions simply never
        // appear: across 14 footprints at 8 rotations each, the ONLY thing this
        // fills is the one real median, stable at 227 sq ft to the square foot
        // at every rotation.
        //
        // reach = area / perimeter is half the width of any elongated region,
        // so closing at that radius bridges precisely the gaps that are
        // narrower than the paving flanking them. That is the engineering
        // meaning of a median -- narrower than what it divides -- rather than a
        // fitted number, and it is why the gap inside a U-shaped drive is left
        // alone: on the staple fixtures the gap is 40ft between 13.3ft legs,
        // far too wide to seal.
        public static List<Polygon> Find(Polygon polygon)
        {
            var found = new List<Polygon>();

            double reach = polygon.Area / polygon.Length;
            if (reach <= 0) return found;

            var joins = new BufferParameters
            {
                JoinStyle = JoinStyle.Mitre,
                MitreLimit = 5.0,
                EndCapStyle = EndCapStyle.Flat,
            };
            var filled = polygon.Buffer(reach, joins).Buffer(-reach, joins).Difference(polygon);

            for (int i = 0; i < filled.NumGeometries; i++)
            {
                if (filled.GetGeometryN(i) is not Polygon gap) continue;
                // A convex footprint fills nothing, and NTS reports that as one
                // EMPTY polygon rather than as zero geometries. The area floor
                // is for slivers left by the buffer round trip's own arithmetic
                // -- it is numerical noise, far below any real dimension, not a
                // judgement about how small a median can be.
                if (gap.IsEmpty || gap.Area < 0.5) continue;
                found.Add(gap);
            }
            return found;
        }

        // The footprint with its medians bridged: what the skeleton, the runs
        // and the apron search all run against, so a divided drive reads as one
        // drive. The caller keeps the original for everything measurable.
        public static Polygon Bridge(Polygon polygon, IReadOnlyList<Polygon> medians)
        {
            Geometry bridged = polygon;
            foreach (var median in medians) bridged = bridged.Union(median);
            return bridged as Polygon ?? polygon;
        }
    }
}

// ===== src/Part1_Identify/Core/SkeletonExtractor.cs =====
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

// ===== src/Part1_Identify/Core/WidthProfile.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Local width measurement along a skeleton. Ported from
    // reference/core/width_profile.py.
    //
    // For each skeleton node, the distance to the nearest polygon boundary is half
    // the local footprint width at that point (standard medial-axis property: every
    // skeleton point is equidistant from at least two boundary points, and that
    // distance is the inscribed-circle radius).
    public sealed class WidthProfile
    {
        public IReadOnlyDictionary<int, double> NodeWidth { get; }

        public WidthProfile(IReadOnlyDictionary<int, double> nodeWidth)
        {
            NodeWidth = nodeWidth;
        }

        public double EdgeWidth(SkeletonGraph graph, int edgeIndex)
        {
            var (a, b) = graph.Edges[edgeIndex];
            return (NodeWidth[a] + NodeWidth[b]) / 2.0;
        }

        public static WidthProfile Compute(Polygon polygon, SkeletonGraph graph)
        {
            var boundary = polygon.ExteriorRing;
            var gf = polygon.Factory;
            var nodeWidth = new Dictionary<int, double>();
            for (int i = 0; i < graph.Nodes.Count; i++)
            {
                double d = boundary.Distance(gf.CreatePoint(graph.Nodes[i]));
                nodeWidth[i] = 2.0 * d;
            }
            return new WidthProfile(nodeWidth);
        }
    }
}

// ===== src/Part1_Identify/Core/SkeletonPruning.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Collapses spurious short branches from a raw extracted skeleton, before
    // segmentation/classification run on top of it.
    //
    // Not present in the Python prototype -- reference/docs/approach.md flagged
    // this as the required-but-unimplemented next step: raw Voronoi-based medial
    // axis produced 21 segmented runs on a synthetic 3-zone test shape. This is a
    // generic property of the method, not specific to that shape: every reflex
    // (concave) vertex of the input polygon generates one leaf-ending skeleton
    // spur pointing at it, which is a geometric artifact of the medial-axis
    // definition, not a real functional-zone boundary. A driveway pad meeting a
    // strip has at least 2 such reflex corners; a stall notch adds more.
    //
    // Distinguishing rule: a corner-artifact spur's length is bounded by the local
    // feature size near that corner, while a genuine functional branch (e.g. a
    // stall bay leading off an aisle) is long relative to the width of what it
    // connects to. So pruning is width-adaptive, not a fixed length cutoff -- a
    // fixed threshold can't work across a 12ft strip and a 60ft pad in the same
    // shape (see feedback: don't calibrate to one shape's scale).
    //
    // Length alone isn't enough, though: a compact, roughly-square blocky region
    // (e.g. a 20x20ft pad) has almost no interior medial-axis spine of its own --
    // a square's true medial axis is a single point -- so the short stub leading
    // into it looks exactly like a short corner-ear spur by length alone, and
    // gets pruned away too, silently erasing the whole pad (found by testing
    // against a case with a compact square pad, not the elongated ones tried
    // first). The fix: also check the width AT THE SPUR'S OWN TIP. A true
    // corner-ear spur's tip approaches the actual polygon vertex, where width
    // shrinks toward zero; a spur leading into a real (if compact) sub-region
    // keeps a tip width comparable to the branch it attaches to.
    public static class SkeletonPruning
    {
        public sealed record PruneResult(SkeletonGraph Graph, WidthProfile Profile, int SpursRemoved);

        // lengthToWidthRatio: a leaf spur is pruned if its length is less than
        // this fraction of the width at the branch node it attaches to.
        // tipConvergenceRatio: ...and only if its own tip width is also less
        // than this fraction of that same branch width (i.e. it's actually
        // narrowing toward a corner, not just short). Both are explicit
        // placeholders, not derived from a formula -- but 0.5 isn't an
        // arbitrary guess either: across every corner-ear spur measured so
        // far (several shapes' worth), the highest tipConvRatio seen for a
        // genuine artifact was 0.30 (a spur that setting this to exactly 0.3
        // narrowly failed to prune, leaving a visible stray sliver), and the
        // lowest seen for a genuine structural connection was ~1.0 -- 0.5
        // sits in the middle of that observed gap with real margin on both
        // sides, not just past the one failing case.
        public static PruneResult Prune(
            SkeletonGraph graph,
            WidthProfile profile,
            double lengthToWidthRatio = 0.75,
            double tipConvergenceRatio = 0.5)
        {
            var adjacency = graph.BuildAdjacency().ToDictionary(kv => kv.Key, kv => new HashSet<int>(kv.Value));
            int totalRemoved = 0;

            // Each pass either removes at least one node or breaks (via one of the
            // two conditions below) -- node count is finite and strictly
            // decreasing, so this always terminates.
            while (true)
            {
                var leaves = adjacency.Where(kv => kv.Value.Count == 1).Select(kv => kv.Key).ToList();
                if (leaves.Count == 0) break;

                // Decide every removal in this pass against the adjacency snapshot
                // as it stood at the start of the pass, then apply them all
                // together. Mutating mid-pass is wrong: pruning one corner-ear
                // spur drops its branch node's degree, which then makes a SIBLING
                // ear at that same branch look like it merges into the main spine
                // (degree check reads <3 and refuses to prune it) purely because
                // of iteration order, not real geometry. Evaluating all leaves
                // against one consistent snapshot makes siblings independent.
                var toRemove = new List<List<int>>();
                foreach (var leaf in leaves)
                {
                    var leafNbrs = adjacency[leaf];
                    var path = new List<int> { leaf };
                    int prev = leaf;
                    int curr = leafNbrs.First();
                    while (adjacency[curr].Count == 2)
                    {
                        path.Add(curr);
                        int next = adjacency[curr].First(n => n != prev);
                        prev = curr;
                        curr = next;
                    }
                    path.Add(curr); // curr is a branch node (degree != 2), or the far leaf of an unbranched path

                    double spurLength = PathLength(graph, path);
                    double baseWidth = profile.NodeWidth[curr];
                    double tipWidth = profile.NodeWidth[leaf];
                    bool attachesToRealBranch = adjacency[curr].Count >= 3;
                    bool isShort = spurLength < lengthToWidthRatio * baseWidth;
                    bool tipConverges = tipWidth < tipConvergenceRatio * baseWidth;

                    if (attachesToRealBranch && isShort && tipConverges)
                        toRemove.Add(path);
                }
                if (toRemove.Count == 0) break;

                foreach (var path in toRemove)
                {
                    for (int i = 0; i < path.Count - 1; i++)
                    {
                        int a = path[i], b = path[i + 1];
                        adjacency[a].Remove(b);
                        adjacency[b].Remove(a);
                    }
                    foreach (var n in path.Take(path.Count - 1))
                        adjacency.Remove(n);
                    totalRemoved++;
                }
            }

            var survivingNodes = adjacency.Keys.OrderBy(k => k).ToList();
            var oldToNew = survivingNodes.Select((old, idx) => (old, idx)).ToDictionary(x => x.old, x => x.idx);

            var newNodes = survivingNodes.Select(i => graph.Nodes[i]).ToList();
            // adjacency is symmetric, so every edge shows up twice (once from each
            // endpoint) -- keeping only the old < nbr direction dedupes for free.
            var newEdges = new List<(int, int)>();
            foreach (var old in survivingNodes)
                foreach (var nbr in adjacency[old])
                    if (old < nbr)
                        newEdges.Add((oldToNew[old], oldToNew[nbr]));

            var newProfile = new WidthProfile(
                survivingNodes.ToDictionary(old => oldToNew[old], old => profile.NodeWidth[old]));

            return new PruneResult(new SkeletonGraph(newNodes, newEdges), newProfile, totalRemoved);
        }

        static double PathLength(SkeletonGraph graph, List<int> path)
        {
            double total = 0;
            for (int i = 0; i + 1 < path.Count; i++)
            {
                var a = graph.Nodes[path[i]];
                var b = graph.Nodes[path[i + 1]];
                double dx = a.X - b.X, dy = a.Y - b.Y;
                total += Math.Sqrt(dx * dx + dy * dy);
            }
            return total;
        }
    }
}

// ===== src/Part1_Identify/Core/RunSegmenter.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Splits a (pruned) skeleton graph into runs, ported from
    // reference/core/width_profile.py's constant_width_runs.
    //
    // A new run starts at every branch node (degree >= 3) and every endpoint
    // (degree 1), not just at width changes -- width alone under-determines the
    // label (a drive strip and an aisle can have overlapping width ranges; what
    // changes is what the segment connects to). This is a *segmentation* step,
    // not a *classification* step -- see Classifier for labeling.
    public static class RunSegmenter
    {
        public static List<List<int>> ConstantWidthRuns(SkeletonGraph graph, WidthProfile profile, double tolerance)
        {
            var adjacency = graph.BuildAdjacency();
            var visitedEdges = new HashSet<(int, int)>();
            var runs = new List<List<int>>();

            static (int, int) EdgeKey(int a, int b) => a < b ? (a, b) : (b, a);

            var seedNodes = Enumerable.Range(0, graph.Nodes.Count).Where(i => adjacency[i].Count != 2).ToList();
            if (seedNodes.Count == 0 && graph.Nodes.Count > 0)
                seedNodes.Add(0); // closed loop with no branches; arbitrary start

            foreach (var start in seedNodes)
            {
                foreach (var neighbor in adjacency[start])
                {
                    var key = EdgeKey(start, neighbor);
                    if (visitedEdges.Contains(key)) continue;

                    // Walk the full chain from this seed all the way to the
                    // next real branch/endpoint, splitting into a new run
                    // wherever width crosses tolerance along the way, rather
                    // than stopping at the first crossing. Stopping outright
                    // silently drops whatever lies beyond it when a chain has
                    // more than one width transition before reaching another
                    // real seed -- found on a "staple" shape (two narrow legs
                    // + a wide crossbar): once pruning removes the legs'
                    // corner-ear spurs, each leg-to-crossbar junction itself
                    // drops to degree 2 (it only had one real branch beyond
                    // its two now-removed ears), so the whole shape becomes
                    // one simple path with only the two leg-ends as real
                    // endpoints -- and the crossbar's core sits entirely past
                    // both legs' individual tolerance crossings, never
                    // claimed by either walk.
                    int prev = start, curr = neighbor;
                    var run = new List<int> { start };
                    double runStartWidth = profile.NodeWidth[start];

                    while (true)
                    {
                        visitedEdges.Add(EdgeKey(prev, curr));
                        run.Add(curr);

                        bool widthExceeded = System.Math.Abs(profile.NodeWidth[curr] - runStartWidth) > tolerance;
                        bool reachedSeed = adjacency[curr].Count != 2;

                        if (widthExceeded && !reachedSeed)
                        {
                            runs.Add(run);
                            run = new List<int> { curr };
                            runStartWidth = profile.NodeWidth[curr];
                        }
                        if (reachedSeed) break;

                        var nexts = adjacency[curr].Where(n => n != prev).ToList();
                        if (nexts.Count == 0) break;
                        prev = curr;
                        curr = nexts[0];
                    }
                    runs.Add(run);
                }
            }
            return runs;
        }
    }
}

// ===== src/Part1_Identify/Core/Classifier.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Apron is not decided by the aspect-ratio rule below -- it comes from the
    // boundary's fillet arcs, see ApronFinder. It lives in the same enum so
    // there is one list of what a paved region can be, and one source for the
    // tag text.
    public enum Category
    {
        Drive,
        Lot,
        Apron,
    }

    public sealed record ClassifiedRun(List<int> NodeIndices, double AvgWidth, double Length, Category Category, string Reason);

    // Classifies each pruned skeleton run as either a linear "drive" element or
    // a blocky "lot" element (parking/maneuvering area -- not split further
    // yet into stall bay/turnaround). At this stage the only goal is a
    // reliable linear-vs-blocky split, not fine-grained zone labels or
    // dimensional thresholds -- see reference/docs/approach.md for the fuller
    // taxonomy this can grow back into later.
    //
    // Signal: aspect ratio (run length along the skeleton / average width). A
    // drive strip is long relative to its width; a parking pad is roughly as
    // wide as it is long. This is more general than the previous approach
    // (what a run connects to -- touches a branch, touches an endpoint): a
    // wide dead-end run and a narrow dead-end run both "terminate at an
    // endpoint", but only one of them is actually shaped like a driveway.
    public static class Classifier
    {
        // A run is "drive" if its length is at least this many times its
        // average width. Explicit placeholder, not derived from real
        // geometry -- tune against test fixtures.
        public const double DriveAspectRatio = 2.5;

        public static List<ClassifiedRun> ClassifyRuns(SkeletonGraph graph, WidthProfile profile, List<List<int>> runs)
        {
            var results = new List<ClassifiedRun>();
            foreach (var run in runs)
            {
                var widths = run.Select(i => profile.NodeWidth[i]).ToList();
                double avg_width = widths.Average();
                double length = RunLength(graph, run);
                double aspect_ratio = length / avg_width;

                var category = aspect_ratio >= DriveAspectRatio ? Category.Drive : Category.Lot;
                var reason = $"length {length:F0}ft / width {avg_width:F0}ft = aspect ratio {aspect_ratio:F1}";

                results.Add(new ClassifiedRun(run, avg_width, length, category, reason));
            }
            return MergeAdjacentSameCategory(results, graph, profile);
        }

        // A gradual width taper (e.g. a narrow leg widening into a wide
        // crossbar) gets segmented into many small constant-width slices --
        // each one individually classifies correctly (they're all short/wide,
        // so all "Lot"), but that's noise the caller doesn't want. Merge any
        // chain of topologically adjacent runs that share the same category
        // back into one, using RunSegmenter's own contract that a run's first
        // and last node are its two ends.
        static List<ClassifiedRun> MergeAdjacentSameCategory(List<ClassifiedRun> runs, SkeletonGraph graph, WidthProfile profile)
        {
            var result = new List<ClassifiedRun>(runs);
            bool mergedAny = true;
            while (mergedAny)
            {
                mergedAny = false;
                for (int i = 0; i < result.Count && !mergedAny; i++)
                {
                    for (int j = i + 1; j < result.Count && !mergedAny; j++)
                    {
                        if (result[i].Category != result[j].Category) continue;
                        var mergedIndices = TryJoin(result[i].NodeIndices, result[j].NodeIndices);
                        if (mergedIndices == null) continue;

                        var category = result[i].Category;
                        result.RemoveAt(j);
                        result.RemoveAt(i);
                        result.Add(Merged(graph, profile, mergedIndices, category));
                        mergedAny = true;
                    }
                }
            }
            return result;
        }

        // Joins two runs into one ordered node path if they share an end node,
        // reversing/reordering as needed -- null if they don't touch at all.
        static List<int> TryJoin(List<int> a, List<int> b)
        {
            int aStart = a[0], aEnd = a[^1], bStart = b[0], bEnd = b[^1];
            if (aEnd == bStart) return a.Concat(b.Skip(1)).ToList();
            if (aEnd == bEnd) return a.Concat(Enumerable.Reverse(b).Skip(1)).ToList();
            if (aStart == bEnd) return b.Concat(a.Skip(1)).ToList();
            if (aStart == bStart) return Enumerable.Reverse(a).Concat(b.Skip(1)).ToList();
            return null;
        }

        // Re-measures the merged run, but KEEPS the category its constituents
        // already agreed on. Re-deciding the category here is a feedback loop,
        // and a damaging one: a pad's Lot run absorbs the two short taper
        // slices beside it, which lengthens the result enough to push its
        // aspect ratio past DriveAspectRatio, it flips to Drive, and it then
        // merges with the actual drive -- collapsing a whole L-shaped
        // footprint into one "Drive" and losing the lot entirely. Measured on
        // a drive with a 90ft pad: raw runs Lot/Lot/Lot/Drive merged down to a
        // single Drive (merged Lot came to 73ft/28ft = 2.6, just over the 2.5
        // cutoff), while the identical shape with a 60ft pad gave the right
        // Drive+Lot (43ft/28ft = 1.5). Merging is meant to consolidate
        // segmentation noise, not to revisit the classification.
        static ClassifiedRun Merged(SkeletonGraph graph, WidthProfile profile, List<int> run, Category category)
        {
            var widths = run.Select(i => profile.NodeWidth[i]).ToList();
            double avg_width = widths.Average();
            double length = RunLength(graph, run);
            var reason = $"length {length:F0}ft / width {avg_width:F0}ft (merged, kept {category})";
            return new ClassifiedRun(run, avg_width, length, category, reason);
        }

        static ClassifiedRun Classify(SkeletonGraph graph, WidthProfile profile, List<int> run)
        {
            var widths = run.Select(i => profile.NodeWidth[i]).ToList();
            double avg_width = widths.Average();
            double length = RunLength(graph, run);
            double aspect_ratio = length / avg_width;
            var category = aspect_ratio >= DriveAspectRatio ? Category.Drive : Category.Lot;
            var reason = $"length {length:F0}ft / width {avg_width:F0}ft = aspect ratio {aspect_ratio:F1}";
            return new ClassifiedRun(run, avg_width, length, category, reason);
        }

        static double RunLength(SkeletonGraph graph, List<int> run)
        {
            double total = 0;
            for (int i = 0; i + 1 < run.Count; i++)
            {
                var a = graph.Nodes[run[i]];
                var b = graph.Nodes[run[i + 1]];
                double dx = a.X - b.X, dy = a.Y - b.Y;
                total += System.Math.Sqrt(dx * dx + dy * dy);
            }
            return total;
        }
    }
}

// ===== src/Part1_Identify/Core/ApronFinder.cs =====
namespace DrivewayChecker.Identify.Core
{
    // Finds aprons: where a drive flares out through fillets on both sides and
    // ends in a segment wider than the drive itself, while not being a lot.
    //
    // Detected from the boundary arcs alone, with no skeleton involved -- the
    // fillets ARE the definition, and their tangent points are exactly where
    // the apron starts and stops, so anything the medial axis could add here
    // would only be an approximation of something the outline already states
    // exactly. This is also why the arcs are preserved rather than faceted
    // away; see BoundaryArc.
    public static class ApronFinder
    {
        // Mouth = the cut across the throat, where the flare begins. Inside =
        // a point known to sit within the apron itself, used afterwards to
        // recognise which split face is the apron.
        // OuterWidth = how wide the flare has opened by its far end. That, not
        // the mouth width, is the apron's characteristic size: the mouth is the
        // narrow throat at the drive.
        public sealed record Apron(Coordinate MouthA, Coordinate MouthB, Coordinate Inside, double OuterWidth);

        public static List<Apron> Find(Polygon polygon, IReadOnlyList<BoundaryArc> arcs, SkeletonGraph graph, WidthProfile profile)
        {
            var found = new List<Apron>();
            if (arcs == null) return found;

            for (int i = 0; i < arcs.Count; i++)
                for (int j = i + 1; j < arcs.Count; j++)
                {
                    var apron = TryPair(polygon, arcs[i], arcs[j]);
                    if (apron == null) continue;
                    if (!IsThroat(apron, graph, profile)) continue;
                    if (!EndsHere(apron, graph.Nodes)) continue;
                    found.Add(apron);
                }
            return found;
        }

        // A real apron's mouth is the drive's throat: the paving's own
        // cross-section at the point the flare begins. The medial axis makes
        // that testable with no shape-specific dimension involved. The local
        // width at a spine point is the NARROWEST chord across the paving there
        // -- it is the inscribed circle's diameter -- so every chord is at
        // least the local width, and a chord matches it only when it genuinely
        // is the cross-section. A diagonal slicing across an interior corner is
        // longer than the paving is wide where it crosses the spine, and that
        // is what gives it away.
        //
        // Measured on the real footprints: a true apron mouth came to 1.04x the
        // local width, and stayed there across two rotations of the same shape
        // -- even though its two fillets are different sizes (r=7.27 one side,
        // r=13.76 the other), so its tangent points are not symmetric. The
        // nearest false mouth, the diagonal across the filleted notch corner
        // that this test exists to reject, came to 1.28x, and the remaining
        // false ones to 1.55x, 1.95x and 2.09x. 1.15 sits in the middle of that
        // gap with real margin on both sides.
        //
        // A mouth the spine never crosses is not a cross-section of anything,
        // so it is rejected outright -- that alone removes the chord lying
        // along the notch's own ceiling.
        //
        // Perpendicularity was the other half of the originally proposed test
        // and is deliberately NOT used: measured, it does not separate these.
        // The real mouths cross the spine at 79 and 73 degrees and the false
        // diagonals at 79 and 76 -- the ranges overlap outright, so an angle
        // window would either keep the false ones or start rejecting real
        // aprons on rotation alone.
        const double ThroatWidthRatio = 1.15;

        static bool IsThroat(Apron apron, SkeletonGraph graph, WidthProfile profile)
        {
            double mouth_width = Distance(apron.MouthA, apron.MouthB);
            foreach (var (a, b) in graph.Edges)
            {
                double t = CrossingParameter(apron.MouthA, apron.MouthB, graph.Nodes[a], graph.Nodes[b]);
                if (t < 0) continue;
                double local_width = profile.NodeWidth[a] * (1 - t) + profile.NodeWidth[b] * t;
                if (mouth_width <= ThroatWidthRatio * local_width) return true;
            }
            return false;
        }

        // Where the spine edge p->q crosses the mouth, as a fraction along
        // p->q -- negative when the two segments don't meet at all.
        static double CrossingParameter(Coordinate mouthA, Coordinate mouthB, Coordinate p, Coordinate q)
        {
            double mx = mouthB.X - mouthA.X, my = mouthB.Y - mouthA.Y;
            double ex = q.X - p.X, ey = q.Y - p.Y;
            double denom = mx * ey - my * ex;
            if (Math.Abs(denom) < 1e-12) return -1; // spine edge runs along the mouth

            double on_mouth = ((p.X - mouthA.X) * ey - (p.Y - mouthA.Y) * ex) / denom;
            double on_edge = ((p.X - mouthA.X) * my - (p.Y - mouthA.Y) * mx) / denom;
            if (on_mouth < 0 || on_mouth > 1 || on_edge < 0 || on_edge > 1) return -1;
            return on_edge;
        }

        // "...flares out with fillets AND ENDS in a wider segment." Flaring
        // alone is not enough: a pair of fillets at an interior corner also
        // widens outward and also spans the paving, and it produced a false
        // APRON on a filleted staple -- a diagonal chord across the corner,
        // with the entire rest of the drive lying beyond it. What separates a
        // real apron is that the drive STOPS there: the paving beyond the
        // mouth is a shallow flare, wider than it is deep. Beyond a false
        // mouth the spine keeps going, far further than the mouth is wide.
        //
        // Depth is compared against OuterWidth, not the mouth width: the mouth
        // is the narrow throat, so a genuine apron is naturally deeper than its
        // mouth is wide (measured: throat 15ft, flare opening to 90ft, depth
        // 40ft). Against the width it actually opens to, a real apron is a
        // shallow fan (40 < 90) while a false mouth has the whole remaining
        // drive beyond it and runs far deeper than the paving is wide.
        //
        // Only nodes lying within the flare's own span are measured -- an
        // unrelated arm of the footprint off to one side must not make a
        // genuine apron look deep.
        static bool EndsHere(Apron apron, IReadOnlyList<Coordinate> skeletonNodes)
        {
            if (skeletonNodes == null || skeletonNodes.Count == 0) return true;

            double mouthWidth = Distance(apron.MouthA, apron.MouthB);
            if (mouthWidth <= 0) return false;

            double ax = (apron.MouthB.X - apron.MouthA.X) / mouthWidth;
            double ay = (apron.MouthB.Y - apron.MouthA.Y) / mouthWidth;

            // normal oriented to point into the apron
            double nx = -ay, ny = ax;
            var mid = Midpoint(apron.MouthA, apron.MouthB);
            if ((apron.Inside.X - mid.X) * nx + (apron.Inside.Y - mid.Y) * ny < 0) { nx = -nx; ny = -ny; }

            double halfSpan = apron.OuterWidth / 2.0;
            double deepest = 0;
            foreach (var node in skeletonNodes)
            {
                double along = (node.X - mid.X) * ax + (node.Y - mid.Y) * ay;
                if (Math.Abs(along) > halfSpan) continue;

                double depth = (node.X - mid.X) * nx + (node.Y - mid.Y) * ny;
                if (depth > deepest) deepest = depth;
            }
            return deepest <= apron.OuterWidth;
        }

        // Two fillets form an apron when the pair of tangent points that can
        // see each other across the paving is CLOSER together than the pair at
        // their other ends -- i.e. the footprint genuinely widens on the way
        // out. That one comparison is "flares out with fillets and ends in a
        // wider segment than the drive itself", and it needs no tuned
        // threshold: either the far end is wider or it isn't.
        static Apron TryPair(Polygon polygon, BoundaryArc a, BoundaryArc b)
        {
            var candidates = new[]
            {
                (Mouth: (a.Start, b.Start), Far: (a.End, b.End)),
                (Mouth: (a.Start, b.End), Far: (a.End, b.Start)),
                (Mouth: (a.End, b.Start), Far: (a.Start, b.End)),
                (Mouth: (a.End, b.End), Far: (a.Start, b.Start)),
            };

            Apron best = null;
            double bestMouth = double.MaxValue;

            foreach (var (mouth, far) in candidates)
            {
                double mouthWidth = Distance(mouth.Item1, mouth.Item2);
                double farWidth = Distance(far.Item1, far.Item2);

                if (farWidth <= mouthWidth) continue;   // doesn't widen -- not a flare
                if (mouthWidth >= bestMouth) continue;  // a tighter throat already found for this pair
                if (!SpansPaving(polygon, mouth.Item1, mouth.Item2)) continue;

                best = new Apron(mouth.Item1, mouth.Item2,
                    Midpoint(Midpoint(mouth.Item1, mouth.Item2), Midpoint(far.Item1, far.Item2)),
                    farWidth);
                bestMouth = mouthWidth;
            }
            return best;
        }

        // The two tangent points have to actually face each other across the
        // paving, not merely happen to widen -- otherwise arcs from opposite
        // ends of a footprint would pair up.
        //
        // Tested on a slightly shortened copy of the mouth, because the tangent
        // points sit exactly ON the boundary by construction: at floating
        // precision "exactly" holds only to a few bits, and testing the
        // full-length segment made the apron vanish on rotated footprints while
        // its unrotated twin was found (same failure mode as the noding issue
        // in SkeletonPreview). Pulling both ends a hair inward turns a fragile
        // boundary-touch into an unambiguous interior test. The trim is far
        // below any real dimension, so it cannot change which pairs qualify.
        const double MouthTrim = 0.01;

        static bool SpansPaving(Polygon polygon, Coordinate a, Coordinate b)
        {
            double length = Distance(a, b);
            if (length <= 2 * MouthTrim) return false;

            double tx = (b.X - a.X) / length * MouthTrim;
            double ty = (b.Y - a.Y) / length * MouthTrim;
            var inner = polygon.Factory.CreateLineString(new[]
            {
                new Coordinate(a.X + tx, a.Y + ty),
                new Coordinate(b.X - tx, b.Y - ty),
            });
            return polygon.Covers(inner);
        }

        static Coordinate Midpoint(Coordinate a, Coordinate b)
            => new Coordinate((a.X + b.X) / 2.0, (a.Y + b.Y) / 2.0);

        static double Distance(Coordinate a, Coordinate b)
            => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));
    }
}

// ===== src/Shared/PolylineCoordinates.cs =====
namespace DrivewayChecker.Shared
{
    static class PolylineCoordinates
    {
        public static Coordinate[] From(Polyline polyline) =>
            polyline.Select(p => new Coordinate(p.X, p.Y)).ToArray();
    }
}

// ===== src/Shared/BrepToPolygon.cs =====
namespace DrivewayChecker.Shared
{
    // Brep -> NTS Polygon. Assumes a single-face, single-loop, planar brep --
    // the only input shape in scope for now (2D/flat brep). The boundary
    // itself can be curved: ToPolyline facets any curve (arcs, fillets, real
    // road edges) into straight segments, and returns the exact original
    // vertices unchanged for an already-straight boundary (verified: same 9
    // points as the raw polyline on a rectilinear T-shape test).
    public static class BrepToPolygon
    {
        public static Polygon Convert(Brep brep, GeometryFactory gf)
        {
            // Not defensive coding for a case outside scope -- a genuinely
            // single-face test brep built via boolean union came out as 2 faces
            // (the union silently failed), and reading Faces[0] anyway analyzed
            // only half the shape with no error. Fail loud instead.
            if (brep.Faces.Count != 1)
                throw new System.ArgumentException($"expected a single-face brep, got {brep.Faces.Count} faces");

            var loop = brep.Faces[0].OuterLoop.To3dCurve();
            var pl = loop.ToPolyline(0.01, RhinoMath.DefaultAngleTolerance, 0, 0).ToPolyline();

            // NTS requires a ring's first and last coordinate to be exactly
            // equal, while Rhino's IsClosed is tolerance-based -- so a
            // rotated footprint reports closed even though its endpoints
            // differ in the last few floating-point bits, and CreatePolygon
            // then throws "points must form a closed linestring". This hit
            // every non-axis-aligned test shape while axis-aligned ones
            // (whose coordinates stay exact) passed. Snap the last
            // coordinate onto the first when the loop is already
            // tolerance-closed, rather than appending, so no near-zero-length
            // segment is introduced.
            var coords = PolylineCoordinates.From(pl);
            if (!coords[0].Equals2D(coords[coords.Length - 1]))
            {
                if (pl.IsClosed) coords[coords.Length - 1] = coords[0];
                else coords = coords.Append(coords[0]).ToArray();
            }

            return gf.CreatePolygon(coords);
        }
    }
}

// ===== src/Shared/CurveToLineString.cs =====
namespace DrivewayChecker.Shared
{
    // Curve -> NTS LineString, for the road centerline input. Same faceting
    // approach as BrepToPolygon -- handles a curved centerline, not just a
    // straight/polyline one.
    public static class CurveToLineString
    {
        public static LineString Convert(Curve curve, GeometryFactory gf)
        {
            var pl = curve.ToPolyline(0.01, RhinoMath.DefaultAngleTolerance, 0, 0).ToPolyline();
            return gf.CreateLineString(PolylineCoordinates.From(pl));
        }
    }
}

// ===== src/Part1_Identify/BrepArcs.cs =====
namespace DrivewayChecker.Identify
{
    // Pulls the genuine arcs out of a footprint's outer loop, alongside (not
    // instead of) BrepToPolygon's faceted polygon. Kept as its own small step
    // rather than folded into BrepToPolygon so each does one thing: that one
    // produces the polygon every NTS operation needs, this one preserves what
    // faceting throws away. See BoundaryArc for why the arcs matter.
    public static class BrepArcs
    {
        public static List<BoundaryArc> Extract(Brep brep, double tolerance = 0.01)
        {
            var arcs = new List<BoundaryArc>();
            var segments = new List<Curve>();
            Flatten(brep.Faces[0].OuterLoop.To3dCurve(), segments);

            foreach (var segment in segments)
            {
                if (segment.IsLinear(tolerance)) continue;
                if (!segment.TryGetArc(out var arc, tolerance)) continue;

                arcs.Add(new BoundaryArc(
                    ToCoordinate(arc.StartPoint),
                    ToCoordinate(arc.EndPoint),
                    ToCoordinate(arc.Center),
                    arc.Radius));
            }
            return arcs;
        }

        // Explode() only un-joins ONE level, and a real filleted outline nests:
        // on the user's flared drive each long side came back as a single
        // PolyCurve holding its straight run already joined to its fillet.
        // TryGetArc on that whole line+arc segment fails, so the fillets were
        // invisible -- measured, 4 shallow segments and 0 arcs found, against 6
        // segments and both real fillets (r=7.27 and r=13.76) when flattened
        // recursively. Finding no arcs is silent and looks like a
        // classification bug rather than a lost input: ApronFinder has nothing
        // to pair, so the apron goes undetected and the flare inherits the
        // drive's label. A purely straight loop isn't a PolyCurve at all and
        // simply has no arcs to find.
        static void Flatten(Curve curve, List<Curve> segments)
        {
            if (curve is PolyCurve poly)
                foreach (var segment in poly.Explode()) Flatten(segment, segments);
            else
                segments.Add(curve);
        }

        static Coordinate ToCoordinate(Point3d p) => new Coordinate(p.X, p.Y);
    }
}

// ===== src/Part1_Identify/IdentifyRun.cs =====
// BrepToPolygon lives in Shared with the other Rhino <-> NTS plumbing

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

// ===== src/Part1_Identify/RegionBuilder.cs =====
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

// ===== src/Part1_Identify/SkeletonPreview.cs =====
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

// ===== src/Part2_Dimensions/DimensionRun.cs =====
namespace DrivewayChecker.Dimensions
{
    // Part 2 -- pull the dimension each identified region's code check needs.
    // Part 1 says what a region is; this says how big it is. Nothing here
    // decides whether a number passes, which is Part 3.
    //
    // Everything is measured on REAL PAVING (IdentifiedRegion.Lanes), never on
    // the bridged footprint, so a grass median is never reported as drive
    // surface.
    public static class DimensionRun
    {
        // A measurement, with somewhere to draw it. Value is the raw number so
        // Part 3 can check it without parsing text back out of a label. Region
        // is null for a radius, which sits on the boundary between two regions
        // rather than inside either.
        public sealed record Dimension(string Kind, double Value, string Text, Coordinate At, IdentifiedRegion Region);

        // Sample spacing for a lane's own skeleton. Matches IdentifyRun's, so
        // every width in the tool is measured at the same resolution.
        const double SampleSpacing = 2.0;

        // A corridor and a block are measured differently, because they are
        // different shapes and the same tool does not work on both.
        //
        // A DRIVE is a corridor: width follows its path (so it survives a bend)
        // and length is area / width, which for a near-constant-width strip IS
        // its arc length. Verified against known geometry: 60.1 for a true 60,
        // 141.0 for 140.6, 90.2 for 90. The skeleton run's own length is NOT
        // used -- segmentation trims its ends, so it reads about 10% short (53
        // against a true 60).
        //
        // A LOT is a block: its minimum-area bounding rectangle IS its length
        // and width, exact on the real pads measured (24.0 x 30.0, 40.0 x 50.0,
        // 20.0 x 20.0). The width profile cannot be used on a block at all --
        // a square's medial axis is a single point, so there is no corridor to
        // measure along. On an irregular lot the rectangle is a loose fit and
        // over-reports, which is honest for an overall extent.
        public static List<Dimension> RegionSizes(IReadOnlyList<IdentifiedRegion> regions, WidthProfile profile)
        {
            var found = new List<Dimension>();
            foreach (var region in regions)
            {
                var biggest = region.Lanes.OrderByDescending(lane => lane.Area).First();
                var anchor = biggest.Centroid.Coordinate;

                if (region.Category == Category.Drive)
                {
                    var lane_widths = region.Lanes.Select(LaneWidth).ToList();
                    double own_width = LaneWidth(biggest);
                    double length = biggest.Area / own_width;

                    // The lanes of a divided drive run alongside each other, so
                    // the drive is as long as one of them, not as long as both.
                    string width_text = lane_widths.Count < 2
                        ? $"{lane_widths[0]:F1}"
                        : DividedWidthText(lane_widths, region, profile);

                    found.Add(new Dimension("drive_size", own_width,
                        $"L = {length:F1} / W = {width_text}", anchor, region));
                }
                else if (region.Category == Category.Lot)
                {
                    var (width, length) = BlockSize(biggest);
                    found.Add(new Dimension("lot_size", width,
                        $"L = {length:F1} / W = {width:F1}", anchor, region));
                }
            }
            return found;
        }

        // "7.9+2.1+8.0=18.0" -- the lanes, the median between them, and the
        // whole crossing. Both figures answer different code questions: each
        // travel lane has to be wide enough on its own, while a rule about
        // total driveway width at the street wants the whole crossing.
        //
        // The middle term is the median, and it has to be shown or the line
        // does not add up: the lanes come to 15.9 while the crossing is 18.0,
        // and a reader who checks the arithmetic on a QC drawing should find it
        // correct. It is derived as total - lanes rather than measured
        // separately, so the sum balances by construction.
        static string DividedWidthText(List<double> lane_widths, IdentifiedRegion region, WidthProfile profile)
        {
            double paved = lane_widths.Sum();

            // The whole crossing, median included -- taken from the bridged
            // spine, because that is the only thing spanning both lanes.
            double total = region.Run == null
                ? paved
                : Median(region.Run.NodeIndices.Select(node => profile.NodeWidth[node]));

            // Round FIRST, then derive the median term from the rounded
            // figures, so the digits actually printed add up. Rounding each
            // term independently does not: 7.9 + 2.2 + 8.0 prints as 18.0 while
            // the visible digits come to 18.1, which is exactly the kind of
            // thing a reviewer spots on a QC drawing.
            double shown_total = Math.Round(total, 1);
            var shown_lanes = lane_widths.Select(w => Math.Round(w, 1)).ToList();
            double shown_gap = Math.Round(shown_total - shown_lanes.Sum(), 1);

            if (shown_lanes.Count == 2 && shown_gap > 0)
                return $"{shown_lanes[0]:F1}+{shown_gap:F1}+{shown_lanes[1]:F1}={shown_total:F1}";

            // More than two lanes, or a total that does not exceed the paving:
            // report what is paved and let the sum speak for itself.
            return $"{string.Join("+", shown_lanes.Select(w => w.ToString("F1")))}={shown_lanes.Sum():F1}";
        }

        // The width of one piece of paving: the MEDIAN of its own width
        // profile, measured on the lane itself rather than borrowed from
        // whichever skeleton run happens to own the region.
        //
        // Median, not minimum, and this was measured rather than assumed. A
        // code minimum ought to be checked against the narrowest point, but the
        // skeleton's minimum is dominated by end effects -- the spine tapers
        // toward zero as it approaches either end of a region -- and reads
        // 4.04, 1.69, 4.92 and 0.03 on lanes whose true widths are 8, 18, 8 and
        // 9.5. The median is stable and lands within ~0.05ft of the exact value
        // on every straight lane measured (11.97 for a true 12, 7.98 for 8,
        // 13.26 for 13.33).
        //
        // Nor the lane's own minimum diameter, which IS exact on a straight
        // region but measures the narrowest slab containing the WHOLE lane, so
        // it reports the slab across a bend rather than the width: 60.00ft
        // against a true 18 on the curved flared drive, where the median gives
        // 17.97. It is kept only as a fallback for a lane too small to
        // skeletonize at all.
        //
        // WARNING: two accuracy limits, both fine for a label and NOT fine for
        // Part 3 checking against a threshold:
        //   - reads ~0.04ft LOW throughout (medial axis sampled at 2ft, and its
        //     nodes zigzag by hundredths). A 12.0ft minimum would spuriously
        //     fail at 11.97.
        //   - under-resolves features near the sample spacing: a ~2ft wide
        //     footprint measured 1.80 against an exact 2.00.
        // The fix is the one that fixed the delineation lines -- measure
        // perpendicular between the two parallel boundary walls, which is exact
        // geometry. Do that before any code checking is wired up.
        public static double LaneWidth(Polygon lane)
        {
            var graph = SkeletonExtractor.ExtractSkeleton(lane, SampleSpacing);
            var pruned = SkeletonPruning.Prune(graph, WidthProfile.Compute(lane, graph));

            var widths = pruned.Profile.NodeWidth.Values.OrderBy(w => w).ToList();
            if (widths.Count == 0) return new MinimumDiameter(lane).Diameter.Length;
            return widths[widths.Count / 2];
        }

        // Short and long side of the minimum-area bounding rectangle.
        static (double Width, double Length) BlockSize(Polygon face)
        {
            var corners = new MinimumDiameter(face).GetMinimumRectangle().Coordinates;
            double shortest = double.MaxValue, longest = 0;
            for (int i = 0; i + 1 < corners.Length; i++)
            {
                double side = corners[i].Distance(corners[i + 1]);
                if (side > longest) longest = side;
                if (side > 1e-9 && side < shortest) shortest = side;
            }
            return (shortest == double.MaxValue ? 0 : shortest, longest);
        }

        static double Median(IEnumerable<double> values)
        {
            var sorted = values.OrderBy(v => v).ToList();
            return sorted.Count == 0 ? 0 : sorted[sorted.Count / 2];
        }

        // Fillet radius where a drive meets a lot -- the turning-radius check
        // needs the radius as drawn, which is why the arcs are carried through
        // unfaceted from the start (see BoundaryArc).
        //
        // "At a drive/lot connection" is decided by what the arc actually sits
        // between: take the two regions nearest the arc, and keep it only when
        // one is a drive and the other a lot. Nearest-two needs no distance
        // threshold, and a fillet in the middle of a drive -- drive on both
        // sides -- is correctly ignored.
        //
        // That test also excludes apron arcs on its own, with no separate rule:
        // an apron is a region like any other now, so a flare's fillets have
        // APRON as one of their two nearest and never see a drive/lot pair. A
        // flare describes how the drive opens out to the street, which is a
        // different check and not in scope yet.
        public static List<Dimension> ConnectionRadii(
            IReadOnlyList<IdentifiedRegion> regions,
            IReadOnlyList<BoundaryArc> arcs)
        {
            var found = new List<Dimension>();
            if (arcs == null) return found;

            foreach (var arc in arcs)
            {
                var midpoint = arc.Midpoint;
                var nearest = regions
                    .Select(region => (region.Category, Gap: region.Face.Distance(region.Face.Factory.CreatePoint(midpoint))))
                    .OrderBy(x => x.Gap)
                    .Take(2)
                    .Select(x => x.Category)
                    .ToList();

                if (!nearest.Contains(Category.Drive) || !nearest.Contains(Category.Lot)) continue;

                found.Add(new Dimension("connection_radius", arc.Radius, $"R={arc.Radius:F1}", midpoint, null));
            }
            return found;
        }
    }
}

// ===== GH entry point =====
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
