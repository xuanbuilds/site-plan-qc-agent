/** The inputs a drawing cannot answer, and how to ask for them.
 *
 * Traffic direction, land use, whether a drive serves a parking lot — none of
 * these are on a typical site plan, and none can be recovered from shape. So
 * rather than leaving CANNOT_DETERMINE for the user to decode, the check that
 * needs one asks the question where the geometry is.
 *
 * Two rules shape how the asking works:
 *
 *  1. ASK WHAT THE USER KNOWS, NOT WHAT THE RULE WANTS. A rule is conditioned on
 *     `driveway_class`, but "minor or major?" is a term of art — answering it
 *     requires already knowing TCM 7.3.1. The user knows what the development
 *     IS. So the question asks land use and the class is derived.
 *  2. ONE QUESTION AT A TIME, and only ones that are still load-bearing. An
 *     answer often resolves several rules at once. */

export type Question = {
	key: string;
	prompt: string;
	options: { label: string; value: unknown }[];
	/** Set when the geometry can already answer this. The question is then put as a
	 * statement to accept or reject, the way the driveway itself is — reading a
	 * measurement back for confirmation is a much smaller ask than a menu. Rejecting
	 * falls through to the full option list. */
	proposal?: Proposal;
};

/** An answer the drawing appears to give, offered for confirmation. */
export type Proposal = {
	value: unknown;
	/** How it is put to the user: a plain claim they can agree or disagree with. */
	statement: string;
};

export type SiteAnswers = Record<string, unknown>;

/** TCM 7.3.1 (minor) and 7.3.2 (major), verbatim in structure:
 *
 *   MINOR — single family, duplex, multi-family of 4 or fewer units
 *   MAJOR — commercial, mixed use, multi-family of more than 4 units,
 *           industrial, other non-residential
 *
 * Note that unit count only decides it WITHIN multi-family. Every non-residential
 * use is major regardless of size, so asking for a unit count alone would answer
 * the wrong question. */
const LAND_USE_QUESTION: Question = {
	key: "land_use",
	prompt: "What does this drive serve?",
	options: [
		{ label: "Single family", value: "single_family" },
		{ label: "Duplex", value: "duplex" },
		{ label: "Multi-family", value: "multi_family" },
		{ label: "Commercial", value: "commercial" },
		{ label: "Mixed use", value: "mixed_use" },
		{ label: "Industrial", value: "industrial" },
		{ label: "Other non-residential", value: "other_non_residential" },
	],
};

/** Only asked for multi-family, and phrased as the threshold the code actually
 * draws rather than as a number — 7.3.1.A.3 against 7.3.2.C. */
const UNIT_COUNT_QUESTION: Question = {
	key: "units_over_four",
	prompt: "How many units?",
	options: [
		{ label: "4 or fewer", value: false },
		{ label: "More than 4", value: true },
	],
};

const DIRECT_QUESTIONS: Record<string, Question> = {
	aisle_direction: {
		key: "aisle_direction",
		prompt: "Is this drive one-way or two-way?",
		options: [
			{ label: "Two-way", value: "two_way" },
			{ label: "One-way", value: "one_way" },
		],
	},
	accesses_parking_lot: {
		key: "accesses_parking_lot",
		prompt: "Does this drive access a parking lot?",
		options: [
			{ label: "Yes", value: true },
			{ label: "No", value: false },
		],
	},
	/** The row of Tables 7-1 and 7-2. Austin classifies every street in its network
	 * table, and the sub-columns split on lane count and median — both of which are
	 * about the street being joined, not about this site, so neither is on the plan.
	 *
	 * These option values are Table 7-1/7-2 vocabulary. Table 7-5 uses a plainer
	 * L1-L4 for the same idea; if that rule is ever made checkable the two will have
	 * to be reconciled rather than both reading `street_level`. */
	street_level: {
		key: "street_level",
		prompt: "What is the street it connects to?",
		options: [
			{ label: "Level 1", value: "L1" },
			{ label: "Level 2", value: "L2" },
			{ label: "Level 2, 3 lanes", value: "L2_3lane" },
			{ label: "Level 3, single median", value: "L3_single_median" },
			{ label: "Level 3-4, multilane", value: "L3_4_multilane" },
		],
	},
	/** Only asked when land use has not already settled it — see `derive`. */
	is_fire_lane: {
		key: "is_fire_lane",
		prompt: "Is this drive a designated fire lane?",
		options: [
			{ label: "No", value: false },
			{ label: "Yes", value: true },
		],
	},
	/** Table 9-2's depth minimum moves with the angle, and not monotonically: 18.5 ft
	 * at 60 and 75 degrees is stricter than the 17.5 ft at 90. So the angle has to be
	 * known before a depth can pass or fail.
	 *
	 * Usually the drawing answers this and `propose_parking_angle` puts it as a
	 * statement instead. These options are the fallback for a plan it cannot read,
	 * and for a user who disagrees with what it read. */
	parking_angle: {
		key: "parking_angle",
		prompt: "What angle do these stalls park at?",
		options: [
			{ label: "90 (head-in)", value: "90" },
			{ label: "75", value: "75" },
			{ label: "60", value: "60" },
			{ label: "45", value: "45" },
			{ label: "30", value: "30" },
		],
	},
	/** Standard is 8 ft-6 in, compact 7 ft-6 in. Asked, not derived from the measured
	 * width: deriving it would make the width check test the measurement against a
	 * threshold the measurement itself chose, which can never fail. */
	stall_type: {
		key: "stall_type",
		prompt: "Are these standard or compact stalls?",
		options: [
			{ label: "Standard", value: "standard" },
			{ label: "Compact", value: "compact" },
		],
	},
};

const MINOR_USES = new Set(["single_family", "duplex"]);

/** How far a measured stall angle may sit from a standard one and still be read as
 * that angle. A drafter snaps stalls to the table's angles, so anything in between
 * is a sign the reading is wrong rather than a site parked at 52 degrees. Both
 * stalls on the test plan measure 89.93, which is 0.07 off. */
const ANGLE_SNAP_TOLERANCE_DEG = 5;

/** What the drawing appears to say about how the stalls are parked.
 *
 * Returns nothing rather than a guess in three cases: no stall could be read, a
 * reading does not land on one of Table 9-2's angles, or the stalls disagree with
 * each other. A mixed-angle lot is a real thing, and one proposal cannot describe
 * it — so the user gets the plain question instead. */
export function propose_parking_angle(measured_deg: readonly (number | null)[]): Proposal | null
{
	const snapped = new Set<string>();
	for (const measured of measured_deg)
	{
		if (measured === null) continue;
		const nearest = PARKING_ANGLES.reduce((best, angle) =>
			Math.abs(angle - measured) < Math.abs(best - measured) ? angle : best
		);
		if (Math.abs(nearest - measured) > ANGLE_SNAP_TOLERANCE_DEG) return null;
		snapped.add(String(nearest));
	}
	if (snapped.size !== 1) return null;

	const [value] = [...snapped];
	const many = measured_deg.filter((m) => m !== null).length > 1;
	return {
		value,
		statement:
			value === "90"
				? `${many ? "These stalls look" : "This stall looks"} like head-in parking, square to the drive.`
				: `${many ? "These stalls look" : "This stall looks"} like ${value}° angled parking.`,
	};
}

const PARKING_ANGLES = [30, 45, 60, 75, 90];

/** Fills in everything that follows from what the user has already said, so a
 * derived condition never has to be asked about directly. */
export function derive(answers: SiteAnswers): SiteAnswers
{
	const derived: SiteAnswers = { ...answers };
	const use = answers.land_use;

	if (typeof use === "string")
	{
		if (MINOR_USES.has(use)) derived.driveway_class = "minor";
		else if (use === "multi_family")
		{
			// 4 or fewer units is minor (7.3.1.A.3); more is major (7.3.2.C).
			if (answers.units_over_four === false) derived.driveway_class = "minor";
			else if (answers.units_over_four === true) derived.driveway_class = "major";
		}
		else derived.driveway_class = "major";
	}

	// The column of Tables 7-1 and 7-2. An industrial site takes the industrial
	// column whether or not the drive is a fire lane, so the fire-lane answer is
	// only load-bearing for everything else - and `next_question` will not ask for
	// it once this has resolved.
	if (use === "industrial") derived.driveway_column = "industrial";
	else if (answers.is_fire_lane === true) derived.driveway_column = "fire";
	else if (answers.is_fire_lane === false && typeof use === "string")
	{
		derived.driveway_column = "typical";
	}

	return derived;
}

/** The next thing worth asking, or null when everything askable has been
 * answered. Whatever is still CANNOT_DETERMINE after that genuinely cannot be
 * resolved here, and is reported as such rather than guessed. */
export function next_question(
	missing_keys: readonly string[],
	answers: SiteAnswers,
	/** Answers the geometry can propose, keyed the same way. A key listed in
	 * `declined` had its proposal rejected, so it falls back to the options. */
	proposals: Record<string, Proposal> = {},
	declined: ReadonlySet<string> = new Set()
): Question | null
{
	for (const key of missing_keys)
	{
		const direct = DIRECT_QUESTIONS[key];
		if (direct && !(key in answers))
		{
			const proposal = proposals[key];
			if (!proposal) return direct;
			// Rejected: ask outright, minus the answer just turned down.
			if (declined.has(key))
			{
				return { ...direct, options: direct.options.filter((o) => o.value !== proposal.value) };
			}
			return { ...direct, proposal };
		}

		if (key === "driveway_class")
		{
			if (!("land_use" in answers)) return LAND_USE_QUESTION;
			if (answers.land_use === "multi_family" && !("units_over_four" in answers))
			{
				return UNIT_COUNT_QUESTION;
			}
		}

		if (key === "driveway_column")
		{
			if (!("land_use" in answers)) return LAND_USE_QUESTION;
			if (answers.land_use !== "industrial" && !("is_fire_lane" in answers))
			{
				return DIRECT_QUESTIONS.is_fire_lane;
			}
		}
	}
	return null;
}
