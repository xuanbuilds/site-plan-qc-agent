using NetTopologySuite.Geometries;

namespace DrivewayChecker.Tests
{
    // Synthetic footprints for validating the core pipeline standalone, no Rhino
    // round-trip needed. Dimensions in feet.
    public static class SyntheticFootprints
    {
        // Pad 24x30ft + strip 12ft wide x 60ft long, meeting at a centered
        // T-junction. Matches the live Rhino test geometry ("PadAndStrip") from
        // the original handoff -- but flagged there as maybe not representative,
        // since real driveways are more often offset/L than centered-T.
        public static Polygon CenteredTPad(GeometryFactory gf)
        {
            var pad = Rect(gf, -12, 0, 12, 30);
            var strip = Rect(gf, -6, -60, 6, 0);
            return (Polygon)pad.Union(strip);
        }

        // Same pad+strip dimensions, but the strip is flush with the pad's left
        // edge instead of centered -- the offset-L case flagged as the more
        // representative real-world shape.
        public static Polygon OffsetLPad(GeometryFactory gf)
        {
            var pad = Rect(gf, 0, 0, 24, 30);
            var strip = Rect(gf, 0, -60, 12, 0);
            return (Polygon)pad.Union(strip);
        }

        // Direct port of reference/tests/test_synthetic_shape.py's shape: a 12ft
        // strip feeding a 24ft aisle, with a 9x18ft stall notch cut into the
        // aisle's far side. The prototype's own "not real Austin TCM geometry"
        // caveat carries over unchanged.
        public static Polygon StripAisleWithStallNotch(GeometryFactory gf)
        {
            var strip = Rect(gf, 0, 0, 60, 12);
            var aisle = Rect(gf, 50, -6, 90, 18);
            var combined = strip.Union(aisle);
            var notch = Rect(gf, 65, 18, 74, 27);
            return (Polygon)combined.Union(notch);
        }

        static Polygon Rect(GeometryFactory gf, double x1, double y1, double x2, double y2)
            => gf.CreatePolygon(new[]
            {
                new Coordinate(x1, y1), new Coordinate(x2, y1),
                new Coordinate(x2, y2), new Coordinate(x1, y2),
                new Coordinate(x1, y1),
            });
    }
}
