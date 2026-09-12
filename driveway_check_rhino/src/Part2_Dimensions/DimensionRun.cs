using System;
using System.Collections.Generic;
using System.Linq;
using NetTopologySuite.Algorithm;
using NetTopologySuite.Geometries;
using DrivewayChecker.Identify;
using DrivewayChecker.Identify.Core;

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
