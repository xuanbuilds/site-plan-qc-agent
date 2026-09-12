using System.Collections.Generic;
using NetTopologySuite.Geometries;

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
