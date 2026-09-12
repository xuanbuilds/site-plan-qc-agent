using System.Linq;
using Rhino.Geometry;
using NetTopologySuite.Geometries;

namespace DrivewayChecker.Shared
{
    static class PolylineCoordinates
    {
        public static Coordinate[] From(Polyline polyline) =>
            polyline.Select(p => new Coordinate(p.X, p.Y)).ToArray();
    }
}
