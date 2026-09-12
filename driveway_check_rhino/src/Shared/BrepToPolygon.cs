using System.Linq;
using Rhino;
using Rhino.Geometry;
using NetTopologySuite.Geometries;

namespace DrivewayChecker.Shared
{
    // Brep -> NTS Polygon. Assumes a single-face, single-loop, planar brep --
    // the only input shape in scope for now (2D/flat brep). The boundary
    // itself can be curved: ToPolyline facets any curve (arcs, fillets, real
    // road edges) into straight segments, and returns the exact original
    // vertices unchanged for an already-straight boundary (verified: same 9
    // points as the raw polyline on a rectilinear T-shape test).
    public static class BrepToPolygon
    {
        public static Polygon Convert(Brep brep, GeometryFactory gf)
        {
            // Not defensive coding for a case outside scope -- a genuinely
            // single-face test brep built via boolean union came out as 2 faces
            // (the union silently failed), and reading Faces[0] anyway analyzed
            // only half the shape with no error. Fail loud instead.
            if (brep.Faces.Count != 1)
                throw new System.ArgumentException($"expected a single-face brep, got {brep.Faces.Count} faces");

            var loop = brep.Faces[0].OuterLoop.To3dCurve();
            var pl = loop.ToPolyline(0.01, RhinoMath.DefaultAngleTolerance, 0, 0).ToPolyline();

            // NTS requires a ring's first and last coordinate to be exactly
            // equal, while Rhino's IsClosed is tolerance-based -- so a
            // rotated footprint reports closed even though its endpoints
            // differ in the last few floating-point bits, and CreatePolygon
            // then throws "points must form a closed linestring". This hit
            // every non-axis-aligned test shape while axis-aligned ones
            // (whose coordinates stay exact) passed. Snap the last
            // coordinate onto the first when the loop is already
            // tolerance-closed, rather than appending, so no near-zero-length
            // segment is introduced.
            var coords = PolylineCoordinates.From(pl);
            if (!coords[0].Equals2D(coords[coords.Length - 1]))
            {
                if (pl.IsClosed) coords[coords.Length - 1] = coords[0];
                else coords = coords.Append(coords[0]).ToArray();
            }

            return gf.CreatePolygon(coords);
        }
    }
}
