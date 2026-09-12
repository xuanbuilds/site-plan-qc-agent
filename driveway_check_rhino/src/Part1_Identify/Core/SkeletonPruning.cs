using System;
using System.Collections.Generic;
using System.Linq;

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
