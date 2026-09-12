using Rhino;
using Rhino.Geometry;
using NetTopologySuite.Geometries;

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
