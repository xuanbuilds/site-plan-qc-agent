using System;
using System.Collections.Generic;
using NetTopologySuite.Geometries;

namespace DrivewayChecker.Identify.Core
{
    // Finds aprons: where a drive flares out through fillets on both sides and
    // ends in a segment wider than the drive itself, while not being a lot.
    //
    // Detected from the boundary arcs alone, with no skeleton involved -- the
    // fillets ARE the definition, and their tangent points are exactly where
    // the apron starts and stops, so anything the medial axis could add here
    // would only be an approximation of something the outline already states
    // exactly. This is also why the arcs are preserved rather than faceted
    // away; see BoundaryArc.
    public static class ApronFinder
    {
        // Mouth = the cut across the throat, where the flare begins. Inside =
        // a point known to sit within the apron itself, used afterwards to
        // recognise which split face is the apron.
        // OuterWidth = how wide the flare has opened by its far end. That, not
        // the mouth width, is the apron's characteristic size: the mouth is the
        // narrow throat at the drive.
        public sealed record Apron(Coordinate MouthA, Coordinate MouthB, Coordinate Inside, double OuterWidth);

        public static List<Apron> Find(Polygon polygon, IReadOnlyList<BoundaryArc> arcs, SkeletonGraph graph, WidthProfile profile)
        {
            var found = new List<Apron>();
            if (arcs == null) return found;

            for (int i = 0; i < arcs.Count; i++)
                for (int j = i + 1; j < arcs.Count; j++)
                {
                    var apron = TryPair(polygon, arcs[i], arcs[j]);
                    if (apron == null) continue;
                    if (!IsThroat(apron, graph, profile)) continue;
                    if (!EndsHere(apron, graph.Nodes)) continue;
                    found.Add(apron);
                }
            return found;
        }

        // A real apron's mouth is the drive's throat: the paving's own
        // cross-section at the point the flare begins. The medial axis makes
        // that testable with no shape-specific dimension involved. The local
        // width at a spine point is the NARROWEST chord across the paving there
        // -- it is the inscribed circle's diameter -- so every chord is at
        // least the local width, and a chord matches it only when it genuinely
        // is the cross-section. A diagonal slicing across an interior corner is
        // longer than the paving is wide where it crosses the spine, and that
        // is what gives it away.
        //
        // Measured on the real footprints: a true apron mouth came to 1.04x the
        // local width, and stayed there across two rotations of the same shape
        // -- even though its two fillets are different sizes (r=7.27 one side,
        // r=13.76 the other), so its tangent points are not symmetric. The
        // nearest false mouth, the diagonal across the filleted notch corner
        // that this test exists to reject, came to 1.28x, and the remaining
        // false ones to 1.55x, 1.95x and 2.09x. 1.15 sits in the middle of that
        // gap with real margin on both sides.
        //
        // A mouth the spine never crosses is not a cross-section of anything,
        // so it is rejected outright -- that alone removes the chord lying
        // along the notch's own ceiling.
        //
        // Perpendicularity was the other half of the originally proposed test
        // and is deliberately NOT used: measured, it does not separate these.
        // The real mouths cross the spine at 79 and 73 degrees and the false
        // diagonals at 79 and 76 -- the ranges overlap outright, so an angle
        // window would either keep the false ones or start rejecting real
        // aprons on rotation alone.
        const double ThroatWidthRatio = 1.15;

        static bool IsThroat(Apron apron, SkeletonGraph graph, WidthProfile profile)
        {
            double mouth_width = Distance(apron.MouthA, apron.MouthB);
            foreach (var (a, b) in graph.Edges)
            {
                double t = CrossingParameter(apron.MouthA, apron.MouthB, graph.Nodes[a], graph.Nodes[b]);
                if (t < 0) continue;
                double local_width = profile.NodeWidth[a] * (1 - t) + profile.NodeWidth[b] * t;
                if (mouth_width <= ThroatWidthRatio * local_width) return true;
            }
            return false;
        }

        // Where the spine edge p->q crosses the mouth, as a fraction along
        // p->q -- negative when the two segments don't meet at all.
        static double CrossingParameter(Coordinate mouthA, Coordinate mouthB, Coordinate p, Coordinate q)
        {
            double mx = mouthB.X - mouthA.X, my = mouthB.Y - mouthA.Y;
            double ex = q.X - p.X, ey = q.Y - p.Y;
            double denom = mx * ey - my * ex;
            if (Math.Abs(denom) < 1e-12) return -1; // spine edge runs along the mouth

            double on_mouth = ((p.X - mouthA.X) * ey - (p.Y - mouthA.Y) * ex) / denom;
            double on_edge = ((p.X - mouthA.X) * my - (p.Y - mouthA.Y) * mx) / denom;
            if (on_mouth < 0 || on_mouth > 1 || on_edge < 0 || on_edge > 1) return -1;
            return on_edge;
        }

        // "...flares out with fillets AND ENDS in a wider segment." Flaring
        // alone is not enough: a pair of fillets at an interior corner also
        // widens outward and also spans the paving, and it produced a false
        // APRON on a filleted staple -- a diagonal chord across the corner,
        // with the entire rest of the drive lying beyond it. What separates a
        // real apron is that the drive STOPS there: the paving beyond the
        // mouth is a shallow flare, wider than it is deep. Beyond a false
        // mouth the spine keeps going, far further than the mouth is wide.
        //
        // Depth is compared against OuterWidth, not the mouth width: the mouth
        // is the narrow throat, so a genuine apron is naturally deeper than its
        // mouth is wide (measured: throat 15ft, flare opening to 90ft, depth
        // 40ft). Against the width it actually opens to, a real apron is a
        // shallow fan (40 < 90) while a false mouth has the whole remaining
        // drive beyond it and runs far deeper than the paving is wide.
        //
        // Only nodes lying within the flare's own span are measured -- an
        // unrelated arm of the footprint off to one side must not make a
        // genuine apron look deep.
        static bool EndsHere(Apron apron, IReadOnlyList<Coordinate> skeletonNodes)
        {
            if (skeletonNodes == null || skeletonNodes.Count == 0) return true;

            double mouthWidth = Distance(apron.MouthA, apron.MouthB);
            if (mouthWidth <= 0) return false;

            double ax = (apron.MouthB.X - apron.MouthA.X) / mouthWidth;
            double ay = (apron.MouthB.Y - apron.MouthA.Y) / mouthWidth;

            // normal oriented to point into the apron
            double nx = -ay, ny = ax;
            var mid = Midpoint(apron.MouthA, apron.MouthB);
            if ((apron.Inside.X - mid.X) * nx + (apron.Inside.Y - mid.Y) * ny < 0) { nx = -nx; ny = -ny; }

            double halfSpan = apron.OuterWidth / 2.0;
            double deepest = 0;
            foreach (var node in skeletonNodes)
            {
                double along = (node.X - mid.X) * ax + (node.Y - mid.Y) * ay;
                if (Math.Abs(along) > halfSpan) continue;

                double depth = (node.X - mid.X) * nx + (node.Y - mid.Y) * ny;
                if (depth > deepest) deepest = depth;
            }
            return deepest <= apron.OuterWidth;
        }

        // Two fillets form an apron when the pair of tangent points that can
        // see each other across the paving is CLOSER together than the pair at
        // their other ends -- i.e. the footprint genuinely widens on the way
        // out. That one comparison is "flares out with fillets and ends in a
        // wider segment than the drive itself", and it needs no tuned
        // threshold: either the far end is wider or it isn't.
        static Apron TryPair(Polygon polygon, BoundaryArc a, BoundaryArc b)
        {
            var candidates = new[]
            {
                (Mouth: (a.Start, b.Start), Far: (a.End, b.End)),
                (Mouth: (a.Start, b.End), Far: (a.End, b.Start)),
                (Mouth: (a.End, b.Start), Far: (a.Start, b.End)),
                (Mouth: (a.End, b.End), Far: (a.Start, b.Start)),
            };

            Apron best = null;
            double bestMouth = double.MaxValue;

            foreach (var (mouth, far) in candidates)
            {
                double mouthWidth = Distance(mouth.Item1, mouth.Item2);
                double farWidth = Distance(far.Item1, far.Item2);

                if (farWidth <= mouthWidth) continue;   // doesn't widen -- not a flare
                if (mouthWidth >= bestMouth) continue;  // a tighter throat already found for this pair
                if (!SpansPaving(polygon, mouth.Item1, mouth.Item2)) continue;

                best = new Apron(mouth.Item1, mouth.Item2,
                    Midpoint(Midpoint(mouth.Item1, mouth.Item2), Midpoint(far.Item1, far.Item2)),
                    farWidth);
                bestMouth = mouthWidth;
            }
            return best;
        }

        // The two tangent points have to actually face each other across the
        // paving, not merely happen to widen -- otherwise arcs from opposite
        // ends of a footprint would pair up.
        //
        // Tested on a slightly shortened copy of the mouth, because the tangent
        // points sit exactly ON the boundary by construction: at floating
        // precision "exactly" holds only to a few bits, and testing the
        // full-length segment made the apron vanish on rotated footprints while
        // its unrotated twin was found (same failure mode as the noding issue
        // in SkeletonPreview). Pulling both ends a hair inward turns a fragile
        // boundary-touch into an unambiguous interior test. The trim is far
        // below any real dimension, so it cannot change which pairs qualify.
        const double MouthTrim = 0.01;

        static bool SpansPaving(Polygon polygon, Coordinate a, Coordinate b)
        {
            double length = Distance(a, b);
            if (length <= 2 * MouthTrim) return false;

            double tx = (b.X - a.X) / length * MouthTrim;
            double ty = (b.Y - a.Y) / length * MouthTrim;
            var inner = polygon.Factory.CreateLineString(new[]
            {
                new Coordinate(a.X + tx, a.Y + ty),
                new Coordinate(b.X - tx, b.Y - ty),
            });
            return polygon.Covers(inner);
        }

        static Coordinate Midpoint(Coordinate a, Coordinate b)
            => new Coordinate((a.X + b.X) / 2.0, (a.Y + b.Y) / 2.0);

        static double Distance(Coordinate a, Coordinate b)
            => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));
    }
}
