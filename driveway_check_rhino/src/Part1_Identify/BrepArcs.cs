using System.Collections.Generic;
using Rhino.Geometry;
using NetTopologySuite.Geometries;
using DrivewayChecker.Identify.Core;

namespace DrivewayChecker.Identify
{
    // Pulls the genuine arcs out of a footprint's outer loop, alongside (not
    // instead of) BrepToPolygon's faceted polygon. Kept as its own small step
    // rather than folded into BrepToPolygon so each does one thing: that one
    // produces the polygon every NTS operation needs, this one preserves what
    // faceting throws away. See BoundaryArc for why the arcs matter.
    public static class BrepArcs
    {
        public static List<BoundaryArc> Extract(Brep brep, double tolerance = 0.01)
        {
            var arcs = new List<BoundaryArc>();
            var segments = new List<Curve>();
            Flatten(brep.Faces[0].OuterLoop.To3dCurve(), segments);

            foreach (var segment in segments)
            {
                if (segment.IsLinear(tolerance)) continue;
                if (!segment.TryGetArc(out var arc, tolerance)) continue;

                arcs.Add(new BoundaryArc(
                    ToCoordinate(arc.StartPoint),
                    ToCoordinate(arc.EndPoint),
                    ToCoordinate(arc.Center),
                    arc.Radius));
            }
            return arcs;
        }

        // Explode() only un-joins ONE level, and a real filleted outline nests:
        // on the user's flared drive each long side came back as a single
        // PolyCurve holding its straight run already joined to its fillet.
        // TryGetArc on that whole line+arc segment fails, so the fillets were
        // invisible -- measured, 4 shallow segments and 0 arcs found, against 6
        // segments and both real fillets (r=7.27 and r=13.76) when flattened
        // recursively. Finding no arcs is silent and looks like a
        // classification bug rather than a lost input: ApronFinder has nothing
        // to pair, so the apron goes undetected and the flare inherits the
        // drive's label. A purely straight loop isn't a PolyCurve at all and
        // simply has no arcs to find.
        static void Flatten(Curve curve, List<Curve> segments)
        {
            if (curve is PolyCurve poly)
                foreach (var segment in poly.Explode()) Flatten(segment, segments);
            else
                segments.Add(curve);
        }

        static Coordinate ToCoordinate(Point3d p) => new Coordinate(p.X, p.Y);
    }
}
