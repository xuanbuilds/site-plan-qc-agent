/** Linear-vs-blocky classification of skeleton runs.
 *
 * Ported from Part1_Identify/Core/Classifier.cs.
 *
 * Signal is aspect ratio: run length along the skeleton over average width. A
 * drive strip is long relative to its width; a parking pad is roughly as wide as
 * it is long. APRON is not decided here — it comes from the boundary fillets,
 * see apron-finder. It shares the enum so there is one list of what a paved
 * region can be. */

import { path_length, type SkeletonGraph } from "./skeleton-graph";
import type { WidthProfile } from "./width-profile";

export type Category = "DRIVE" | "LOT" | "APRON" | "STALL";

export type ClassifiedRun = {
	node_indices: number[];
	avg_width: number;
	length: number;
	category: Category;
	reason: string;
};

/** A run is a drive if its length is at least this many times its average width.
 *
 * Described in the original as a placeholder, but it is empirically constrained:
 * a genuine merged Lot measured 73 ft / 28 ft = 2.6, i.e. 0.1 of slack above the
 * cutoff. Treat it as having zero margin. */
export const DRIVE_ASPECT_RATIO = 2.5;

/** Smallest extent a region must have, in feet, before it can be a parking LOT.
 *
 * A lot has to hold at least one stall plus the aisle that reaches it: 18 ft
 * stall depth (TCM Table 9-2) + 20 ft minimum two-way aisle (TCM 9.3.4.2.H).
 * Anything smaller is manoeuvring apron - the patch in front of a garage - and
 * belongs to the drive it opens off.
 *
 * Derived from the rulebook rather than fitted: measured on the townhouse plan,
 * the seven garage-front patches are 21 x 20 ft, and the next real region up is
 * 53 ft, so the cut has wide margin either side. The 73 x 28 ft merged-Lot
 * fixture stays a LOT because 73 > 38. */
export const MIN_LOT_EXTENT_FT = 18 + 20;

function measure(graph: SkeletonGraph, profile: WidthProfile, run: number[])
{
	const widths = run.map((i) => profile.at(i));
	const avg_width = widths.reduce((a, b) => a + b, 0) / widths.length;
	const length = path_length(graph, run);
	return { avg_width, length };
}

export function classify_runs(
	graph: SkeletonGraph,
	profile: WidthProfile,
	runs: number[][]
): ClassifiedRun[]
{
	const classified = runs.map((run) =>
	{
		const { avg_width, length } = measure(graph, profile, run);
		const aspect = length / avg_width;
		// Too small to be a lot at all, whatever its aspect ratio: a garage-front
		// patch is manoeuvring space belonging to the drive, not a parking area.
		const too_small_for_lot = Math.max(length, avg_width) < MIN_LOT_EXTENT_FT;
		const category: Category =
			aspect >= DRIVE_ASPECT_RATIO || too_small_for_lot ? "DRIVE" : "LOT";
		const reason = too_small_for_lot && aspect < DRIVE_ASPECT_RATIO
			? `${length.toFixed(0)} x ${avg_width.toFixed(0)}ft - below ${MIN_LOT_EXTENT_FT}ft, too small for a stall plus aisle`
			: `length ${length.toFixed(0)}ft / width ${avg_width.toFixed(0)}ft = aspect ratio ${aspect.toFixed(1)}`;
		return { node_indices: run, avg_width, length, category, reason };
	});
	return merge_adjacent_same_category(classified, graph, profile);
}

/** A gradual taper segments into many short slices that each classify correctly
 * but are noise to the caller. Merge topologically adjacent runs of the same
 * category back into one. */
function merge_adjacent_same_category(
	runs: ClassifiedRun[],
	graph: SkeletonGraph,
	profile: WidthProfile
): ClassifiedRun[]
{
	const result = [...runs];
	let mergedAny = true;
	while (mergedAny)
	{
		mergedAny = false;
		for (let i = 0; i < result.length && !mergedAny; i++)
		{
			for (let j = i + 1; j < result.length && !mergedAny; j++)
			{
				if (result[i].category !== result[j].category) continue;
				const joined = try_join(result[i].node_indices, result[j].node_indices);
				if (!joined) continue;

				const category = result[i].category;
				result.splice(j, 1);
				result.splice(i, 1);
				result.push(merged(graph, profile, joined, category));
				mergedAny = true;
			}
		}
	}
	return result;
}

/** Joins two runs sharing an end node, reordering as needed. Null if they do not
 * touch. Every reverse copies first — Array.reverse mutates in place, and these
 * arrays are the same instances held by the caller and by emitted runs. */
function try_join(a: number[], b: number[]): number[] | null
{
	const aStart = a[0];
	const aEnd = a[a.length - 1];
	const bStart = b[0];
	const bEnd = b[b.length - 1];
	if (aEnd === bStart) return [...a, ...b.slice(1)];
	if (aEnd === bEnd) return [...a, ...[...b].reverse().slice(1)];
	if (aStart === bEnd) return [...b, ...a.slice(1)];
	if (aStart === bStart) return [...[...a].reverse(), ...b.slice(1)];
	return null;
}

/** Re-measures a merged run but KEEPS the category its parts already agreed on.
 *
 * Re-deciding here is a damaging feedback loop: a pad's Lot run absorbs the two
 * taper slices beside it, which lengthens it past the cutoff, it flips to Drive,
 * and it then merges with the actual drive — collapsing an L-shaped footprint
 * into one Drive and losing the lot. Measured on a 90 ft pad: merged Lot came to
 * 73/28 = 2.6, just over 2.5. The same shape with a 60 ft pad gave 43/28 = 1.5
 * and classified correctly. */
function merged(
	graph: SkeletonGraph,
	profile: WidthProfile,
	run: number[],
	category: Category
): ClassifiedRun
{
	const { avg_width, length } = measure(graph, profile, run);
	return {
		node_indices: run,
		avg_width,
		length,
		category,
		reason: `length ${length.toFixed(0)}ft / width ${avg_width.toFixed(0)}ft (merged, kept ${category})`,
	};
}
