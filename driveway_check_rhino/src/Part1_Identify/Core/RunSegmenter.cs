using System.Collections.Generic;
using System.Linq;

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
