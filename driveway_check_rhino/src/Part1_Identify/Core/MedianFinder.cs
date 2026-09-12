using System.Collections.Generic;
using NetTopologySuite.Geometries;
using NetTopologySuite.Operation.Buffer;

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
