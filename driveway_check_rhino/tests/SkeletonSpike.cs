using System;
using System.Linq;
using NetTopologySuite.Geometries;
using DrivewayChecker.Core;

namespace DrivewayChecker.Tests
{
    // Runs the full pipeline (skeleton -> prune -> segment -> classify) against
    // the synthetic fixtures and prints a before/after pruning comparison. This is
    // the harness for the still-open skeleton-pruning problem: the target is
    // getting segmented-run counts down near the true zone count (2-3 for the
    // pad+strip shapes, ~3-4 for the stall-notch shape), not the raw noisy count.
    //
    // Not a unit test framework (no dotnet SDK on this machine) -- run via the
    // Rhino script editor's C# scripting (`run_csharp` over MCP), which supports
    // both `#r "nuget: ..."` and `#load "path"` against real files. See
    // README.md's "Running the spike" section for the exact invocation.
    public static class SkeletonSpike
    {
        public static void Run(double sampleSpacing = 2.0, double runTolerance = 3.0, double pruneRatio = 0.75)
        {
            var gf = new GeometryFactory();
            var fixtures = new (string Name, Polygon Poly)[]
            {
                ("CenteredTPad", SyntheticFootprints.CenteredTPad(gf)),
                ("OffsetLPad", SyntheticFootprints.OffsetLPad(gf)),
                ("StripAisleWithStallNotch", SyntheticFootprints.StripAisleWithStallNotch(gf)),
            };

            foreach (var (name, poly) in fixtures)
            {
                Console.WriteLine($"=== {name} (area {poly.Area:F1} sq ft, valid={poly.IsValid}) ===");

                var rawGraph = SkeletonExtractor.ExtractSkeleton(poly, sampleSpacing);
                var rawProfile = WidthProfile.Compute(poly, rawGraph);
                var rawRuns = RunSegmenter.ConstantWidthRuns(rawGraph, rawProfile, runTolerance);
                Console.WriteLine($"  raw skeleton: {rawGraph.Nodes.Count} nodes, {rawGraph.Edges.Count} edges, " +
                                   $"{rawGraph.BranchNodes().Count} branch, {rawGraph.EndpointNodes().Count} endpoint " +
                                   $"-> {rawRuns.Count} runs");

                var pruned = SkeletonPruning.Prune(rawGraph, rawProfile, pruneRatio);
                var prunedRuns = RunSegmenter.ConstantWidthRuns(pruned.Graph, pruned.Profile, runTolerance);
                Console.WriteLine($"  pruned ({pruned.SpursRemoved} spurs removed): {pruned.Graph.Nodes.Count} nodes, " +
                                   $"{pruned.Graph.Edges.Count} edges, {pruned.Graph.BranchNodes().Count} branch, " +
                                   $"{pruned.Graph.EndpointNodes().Count} endpoint -> {prunedRuns.Count} runs");

                var classified = Classifier.ClassifyRuns(pruned.Graph, pruned.Profile, prunedRuns);
                foreach (var c in classified.OrderByDescending(c => c.AvgWidth))
                    Console.WriteLine($"    width~{c.AvgWidth,5:F1}ft  zone={c.Zone,-12}  {c.Reason}");

                Console.WriteLine();
            }
        }
    }
}
