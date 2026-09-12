/** Finds grass medians inside a divided drive, and bridges them shut.
 *
 * Ported from Part1_Identify/Core/MedianFinder.cs.
 *
 * Morphological closing: buffer out then back in by the same distance. A gap
 * narrower than twice the reach closes and reappears as a difference against the
 * original; anything wider stays open. Two strips either side of a median are one
 * drive conceptually, so the median is bridged into the analysis polygon before
 * the skeleton runs — otherwise the shape reads as two separate drives. */

import { mitre_buffer, type JtsGeometry, type JtsPolygon } from "./jts";

/** Numerical noise floor, in square feet — NOT a judgement about how small a
 * median can be. If the buffer ever leaves larger slivers, fix the input
 * precision rather than raising this; raising it starts discarding real
 * geometry. */
const MIN_GAP_AREA = 0.5;

export function find_medians(polygon: JtsPolygon): JtsPolygon[]
{
	// Area over perimeter is half the width of an elongated region — derived, not
	// fitted, so it scales with the drive instead of being tuned to one plan.
	const reach = polygon.getArea() / polygon.getLength();
	if (!(reach > 0)) return [];

	// Mitre joins are load-bearing. Round joins produced seven false regions of
	// 4-21 sq ft at concave corners across the fixtures; mitre produced none, with
	// the one real median stable at 227 sq ft across 14 footprints x 8 rotations.
	const closed = mitre_buffer(mitre_buffer(polygon, reach), -reach);
	const filled = closed.difference(polygon);

	// A real median is ENCLOSED by paving: it is a void the drive wraps around, so
	// a thin collar drawn around it lies entirely on paving. A notch between two
	// bays is not - closing it draws a straight line across its mouth, and roughly
	// half that collar sticks out into open ground.
	//
	// Measured on the townhouse plan, which has no median at all: every one of the
	// 14 surviving candidates scores 0.47-0.66, against ~1.0 for a genuine void.
	// The cut sits at 0.9, i.e. "essentially fully enclosed" - a fraction, so it
	// does not scale with the plan, and it has ~0.25 of margin below it.
	//
	// This matters beyond the false positives: bridging these notches deforms the
	// drive enough that the degenerate-junction weld downstream stops firing, so
	// an over-eager median finder silently breaks segmentation too.
	const COLLAR_FT = 0.25;
	const ENCLOSED_FRACTION = 0.9;

	const found: JtsPolygon[] = [];
	for (let i = 0; i < filled.getNumGeometries(); i++)
	{
		const gap = filled.getGeometryN(i);
		if (gap.getGeometryType() !== "Polygon") continue;
		if (gap.isEmpty() || gap.getArea() < MIN_GAP_AREA) continue;

		const collar = mitre_buffer(gap, COLLAR_FT).difference(gap);
		const collar_area = collar.getArea();
		if (!(collar_area > 0)) continue;
		if (collar.intersection(polygon).getArea() / collar_area < ENCLOSED_FRACTION) continue;

		found.push(gap as JtsPolygon);
	}
	return found;
}

/** Unions the medians back in, so the skeleton sees one corridor. */
export function bridge(polygon: JtsPolygon, medians: readonly JtsPolygon[]): JtsPolygon
{
	let bridged: JtsGeometry = polygon;
	for (const median of medians) bridged = bridged.union(median);
	return bridged.getGeometryType() === "Polygon" ? (bridged as JtsPolygon) : polygon;
}
