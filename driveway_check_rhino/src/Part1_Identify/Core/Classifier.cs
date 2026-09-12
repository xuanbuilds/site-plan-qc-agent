using System.Collections.Generic;
using System.Linq;

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
