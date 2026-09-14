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
	/** Shape alone cannot settle this one - it is big enough for a parking module
	 * at some angles and not at others. The category is the better guess; the user
	 * is asked rather than told. */
	ambiguous: boolean;
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
 * A lot has to hold at least one parking module: a stall plus the aisle that
 * reaches it. Both come from TCM Table 9-2, and both depend on the parking
 * angle and the aisle's traffic direction:
 *
 *   30 one-way  16.0 stall + 12 aisle = 28.0   <- the smallest module the code allows
 *   45 one-way  17.0 + 14 = 31.0
 *   60 one-way  18.5 + 16 = 34.5
 *   75 one-way  18.5 + 18 = 36.5
 *   90 two-way  17.5 + 25 = 42.5   <- the largest
 *
 * So below 28 ft no parking module fits at any angle, whatever the answers turn
 * out to be, and the region is manoeuvring apron belonging to the drive it opens
 * off. Between 28 and 42.5 it depends on the angle and direction, which are
 * asked rather than assumed.
 *
 * THIS WAS WRONG BEFORE, and not by tuning. It read 18 + 20, where the 20 came
 * from TCM 9.3.4.2.H - a rule whose own text is "the minimum width for an
 * internal drive or circulation aisle WITH NO PARKING". Using the no-parking
 * aisle width as the aisle half of a stall-plus-aisle module contradicts the
 * sentence it was taken from. Table 9-2 is the rule for aisles that serve
 * parking, and it is the one that belongs here. The 38 ft floor it produced
 * rejected a real 34.7 ft lot on 23a219ff_option_5. */
export const MIN_LOT_EXTENT_FT = 16 + 12;

/** Above this a region can hold a parking module at ANY angle and direction, so
 * no answer the user gives could make it too small. 90-degree stalls off a
 * two-way aisle, the largest module in Table 9-2. */
export const LOT_CERTAIN_EXTENT_FT = 17.5 + 25;

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
		const extent = Math.max(length, avg_width);
		// Too small to be a lot at all, whatever its aspect ratio and whatever the
		// user answers: a garage-front patch is manoeuvring space belonging to the
		// drive, not a parking area.
		const too_small_for_lot = extent < MIN_LOT_EXTENT_FT;
		const category: Category =
			aspect >= DRIVE_ASPECT_RATIO || too_small_for_lot ? "DRIVE" : "LOT";
		// Lot-shaped and big enough for the smallest parking module, but not for
		// every one of them. Whether a module actually fits depends on the parking
		// angle and the aisle's traffic direction, which are answers rather than
		// measurements - so this goes to the user instead of being decided here.
		const ambiguous =
			aspect < DRIVE_ASPECT_RATIO && !too_small_for_lot && extent < LOT_CERTAIN_EXTENT_FT;
		const reason = too_small_for_lot && aspect < DRIVE_ASPECT_RATIO
			? `${length.toFixed(0)} x ${avg_width.toFixed(0)}ft - below ${MIN_LOT_EXTENT_FT}ft, too small for a stall plus aisle at any angle`
			: ambiguous
				? `${length.toFixed(0)} x ${avg_width.toFixed(0)}ft - holds a parking module at some angles but not all`
				: `length ${length.toFixed(0)}ft / width ${avg_width.toFixed(0)}ft = aspect ratio ${aspect.toFixed(1)}`;
		return { node_indices: run, avg_width, length, category, ambiguous, reason };
	});
	return merge_adjacent_same_category(classified, graph, profile);
}

/** Width tolerance for merging, feet. The same figure the segmenter used to cut
 * the runs apart in the first place (RUN_TOLERANCE_FT in index.ts): two stretches
 * whose widths agree within it were never going to be separated, so rejoining
 * them restores what the taper split. Anything wider apart than that was cut for
 * a reason. */
const MERGE_WIDTH_TOLERANCE_FT = 3.0;

/** A gradual taper segments into many short slices that each classify correctly
 * but are noise to the caller. Merge topologically adjacent runs of the same
 * category back into one.
 *
 * Same category is not enough on its own. On 23a219ff_option_5 a 34.7 ft wide
 * lot and a 10.0 ft wide drive both came out DRIVE and were welded into one run
 * reported as 19.0 ft wide - a width that exists nowhere on the plan. The merge
 * exists to rejoin slices of a taper, and those agree in width by definition, so
 * it now also requires that. */
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
				if (Math.abs(result[i].avg_width - result[j].avg_width) > MERGE_WIDTH_TOLERANCE_FT) continue;
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
	const extent = Math.max(length, avg_width);
	return {
		node_indices: run,
		avg_width,
		length,
		category,
		ambiguous: category === "LOT" && extent < LOT_CERTAIN_EXTENT_FT,
		reason: `length ${length.toFixed(0)}ft / width ${avg_width.toFixed(0)}ft (merged, kept ${category})`,
	};
}
