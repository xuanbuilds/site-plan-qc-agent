using System;
using NetTopologySuite.Geometries;

namespace DrivewayChecker.Identify.Core
{
    // A genuine arc in the footprint's outline, as it was actually drawn --
    // kept rather than faceted away with everything else.
    //
    // Two reasons it has to survive the Brep -> polygon conversion. First, a
    // filleted transition is the signal that distinguishes an apron (a drive
    // flaring out to meet the street) from a small lot, and its two tangent
    // points are exactly where the apron should be cut. Second, the radius
    // itself is what a turning-radius code check needs later -- once the
    // outline is faceted into straight segments that number is gone, and
    // re-fitting a circle to facets afterwards would only approximate a value
    // the model already states exactly.
    //
    // Start/End are the arc's tangent points (where it meets the straight
    // stretches on either side), which is what makes them useful as cut
    // anchors. No RhinoCommon dependency here by design -- plain NTS
    // coordinates, same as the rest of Core.
    public sealed record BoundaryArc(Coordinate Start, Coordinate End, Coordinate Center, double Radius)
    {
        public Coordinate Midpoint => new Coordinate((Start.X + End.X) / 2.0, (Start.Y + End.Y) / 2.0);

        // Straight-line distance across the arc, tangent point to tangent
        // point -- the width the flare actually opens up by on this side.
        public double ChordLength => Math.Sqrt(
            (End.X - Start.X) * (End.X - Start.X) + (End.Y - Start.Y) * (End.Y - Start.Y));
    }
}
