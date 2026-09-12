using System.Collections.Generic;
using System.Linq;
using NetTopologySuite.Geometries;

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
