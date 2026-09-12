/** Part 3 — measured dimensions against the rulebook.
 *
 * The rulebook is the boundary between reading the code and checking geometry.
 * Claude read the transportation code once, offline, and emitted a JSON file;
 * nothing here consults a model. Every verdict is a number compared to a number,
 * carrying the provision it came from.
 *
 * CANNOT_DETERMINE is not an error state and not a rounding of FAIL. Most real
 * standards are conditioned on land use, street classification or traffic
 * direction, none of which shape can establish. A checker that silently skips a
 * rule it could not evaluate is worse than no checker, so an unmet condition
 * produces a verdict that names the missing input. */

export type Verdict = "PASS" | "FAIL" | "CANNOT_DETERMINE";

export type Citation = {
	doc: string;
	section: string;
	quote: string;
};

/** One cell of a table rule. `null` means the table leaves that combination blank,
 * which in the TCM means not permitted rather than unlimited. `{in, out}` is a
 * cell that splits the inbound return from the outbound one. */
export type TableCell = number | null | { in: number; out: number };
export type TableLevel = Record<string, TableCell | Record<string, TableCell>>;

export type Rule = {
	id: string;
	status: "checkable" | "needs_input" | "needs_geometry" | "out_of_scope";
	applies_to: string;
	dimension?: string;
	conditions?: Record<string, unknown>;
	min_ft?: number;
	max_ft?: number;
	/** Half the TCM's numbers live in tables, not in single figures — the maximum
	 * curb radius depends on both the street's level and what kind of driveway it
	 * is. `by_keys` names the site parameters to look up, outermost first, because
	 * the table's own nesting order need not match the order the conditions happen
	 * to be written in. */
	by_keys?: string[];
	min_ft_by?: TableLevel;
	max_ft_by?: TableLevel;
	cite: Citation;
	needs_review?: boolean;
	notes?: string;
};

export type Rulebook = {
	source: {
		jurisdiction: string;
		document: string;
		edition: string;
		retrieved: string;
		documents: { id: string; title: string; file: string; coverage: string }[];
		documents_present_but_not_read: { file: string; why: string }[];
	};
	rules: Rule[];
};

/** One measured quantity, tied to the region it came from. */
export type Measurement = {
	region_index: number;
	category: string;
	dimension: string;
	value_ft: number;
};

export type Check = {
	rule_id: string;
	verdict: Verdict;
	region_index: number;
	category: string;
	dimension: string;
	measured_ft: number | null;
	/** The threshold it was tested against, as text — "min 20 ft", "max 25 ft". */
	requirement: string;
	cite: Citation;
	/** Why, in one line. For CANNOT_DETERMINE this names the missing input. */
	reason: string;
	/** Condition keys still unanswered. The UI asks for these rather than leaving
	 * the user to guess what CANNOT_DETERMINE wants - most plans will never state
	 * traffic direction or driveway class on the drawing. */
	missing: string[];
	needs_review: boolean;
};

/** Site parameters a rule may be conditioned on. Anything absent makes every rule
 * that needs it report CANNOT_DETERMINE rather than quietly assuming a value. */
export type SiteParameters = Record<string, unknown>;

/** What a rule resolves to once the site parameters are known: a plain minimum
 * and maximum, or a reason it could not be reduced to one. */
type Threshold = {
	min_ft?: number;
	max_ft?: number;
	/** Set instead of a number when the table can be read but yields no testable
	 * figure — an empty cell, or a cell that splits two cases we cannot tell apart. */
	blocked?: string;
};

/** Walk a table rule's nesting with the answers it is keyed on. Every key is
 * guaranteed present by the time this runs: an unanswered one is caught upstream
 * as a missing condition, so a miss here is a malformed rulebook, not a gap in
 * what the user told us. */
function read_table(table: TableLevel, keys: readonly string[], site: SiteParameters): TableCell | undefined
{
	let level: unknown = table;
	for (const key of keys)
	{
		if (level === null || typeof level !== "object") return undefined;
		level = (level as Record<string, unknown>)[String(site[key])];
		if (level === undefined) return undefined;
	}
	return level as TableCell;
}

function resolve(rule: Rule, site: SiteParameters): Threshold
{
	const table = rule.min_ft_by ?? rule.max_ft_by;
	if (!table || !rule.by_keys) return { min_ft: rule.min_ft, max_ft: rule.max_ft };

	const cell = read_table(table, rule.by_keys, site);
	if (cell === undefined)
	{
		return { blocked: `${rule.cite.section} has no entry for this combination` };
	}
	if (cell === null)
	{
		// A blank cell in a TCM table is a prohibition, not an absent limit. Saying
		// so is the honest read, but it is not a measurement failing a number, so it
		// is surfaced as undetermined rather than asserted as a FAIL.
		return { blocked: `${rule.cite.section} leaves this combination blank — not permitted` };
	}
	if (typeof cell === "object")
	{
		// Table 7-1 gives separate inbound and outbound maxima on a few divided-street
		// rows. We measure both curb returns but cannot tell which one traffic enters
		// by, so neither figure can be applied without guessing.
		return {
			blocked:
				`${rule.cite.section} sets different limits inbound (${cell.in} ft) and ` +
				`outbound (${cell.out} ft), and which return is which is not in the drawing`,
		};
	}

	return rule.min_ft_by ? { min_ft: cell } : { max_ft: cell };
}

function requirement_text(threshold: Threshold): string
{
	const parts: string[] = [];
	if (threshold.min_ft !== undefined) parts.push(`min ${threshold.min_ft} ft`);
	if (threshold.max_ft !== undefined) parts.push(`max ${threshold.max_ft} ft`);
	return parts.length > 0 ? parts.join(", ") : "no numeric threshold";
}

/** Conditions are AND-ed. A key the caller never supplied is unknown, not false —
 * the difference between "this rule does not apply" and "we cannot tell whether
 * it applies", which is exactly what CANNOT_DETERMINE exists to keep visible. */
function unmet_conditions(rule: Rule, site: SiteParameters): string[]
{
	const missing: string[] = [];
	for (const [key, expected] of Object.entries(rule.conditions ?? {}))
	{
		if (!(key in site)) { missing.push(key); continue; }
		// "*" is a table axis, not a value to match: the rule applies whatever the
		// answer is, and the answer picks the column. A list is a set of values the
		// rule applies to. Anything else is a single value.
		if (expected === "*") continue;
		const matches = Array.isArray(expected)
			? expected.includes(site[key])
			: site[key] === expected;
		if (!matches) return ["__not_applicable__"];
	}
	return missing;
}

export function evaluate(
	rulebook: Rulebook,
	measurements: readonly Measurement[],
	site: SiteParameters = {}
): Check[]
{
	const checks: Check[] = [];

	for (const rule of rulebook.rules)
	{
		if (rule.status !== "checkable" || !rule.dimension) continue;

		const matching = measurements.filter(
			(m) => m.dimension === rule.dimension && m.category === rule.applies_to
		);
		if (matching.length === 0) continue;

		const missing = unmet_conditions(rule, site);
		if (missing[0] === "__not_applicable__") continue;

		// The threshold is only known once the conditions are answered, because for a
		// table rule the answers ARE the row and column. Resolving after the missing
		// check keeps that ordering honest.
		const threshold = missing.length > 0 ? null : resolve(rule, site);

		for (const measurement of matching)
		{
			const base = {
				rule_id: rule.id,
				region_index: measurement.region_index,
				category: measurement.category,
				dimension: rule.dimension,
				requirement: threshold ? requirement_text(threshold) : "pending",
				cite: rule.cite,
				needs_review: rule.needs_review !== false,
				missing: [] as string[],
			};

			if (!threshold)
			{
				checks.push({
					...base,
					verdict: "CANNOT_DETERMINE",
					measured_ft: measurement.value_ft,
					reason: `needs ${missing.join(", ")}`,
					missing,
				});
				continue;
			}

			if (threshold.blocked)
			{
				checks.push({
					...base,
					verdict: "CANNOT_DETERMINE",
					measured_ft: measurement.value_ft,
					reason: threshold.blocked,
				});
				continue;
			}

			if (threshold.min_ft === undefined && threshold.max_ft === undefined)
			{
				checks.push({
					...base,
					verdict: "CANNOT_DETERMINE",
					measured_ft: measurement.value_ft,
					reason: "rule carries no numeric threshold to test against",
				});
				continue;
			}

			const value = measurement.value_ft;
			const under = threshold.min_ft !== undefined && value < threshold.min_ft;
			const over = threshold.max_ft !== undefined && value > threshold.max_ft;
			checks.push({
				...base,
				verdict: under || over ? "FAIL" : "PASS",
				measured_ft: value,
				reason: under
					? `${value.toFixed(1)} ft is under the ${threshold.min_ft} ft minimum`
					: over
						? `${value.toFixed(1)} ft is over the ${threshold.max_ft} ft maximum`
						: `${value.toFixed(1)} ft satisfies ${requirement_text(threshold)}`,
			});
		}
	}

	return checks;
}

/** What was consulted, and what was deliberately not — the coverage statement a
 * reviewer needs in order to trust a clean result. */
export function coverage(rulebook: Rulebook)
{
	const by_status: Record<string, number> = {};
	for (const rule of rulebook.rules) by_status[rule.status] = (by_status[rule.status] ?? 0) + 1;
	return {
		jurisdiction: rulebook.source.jurisdiction,
		document: rulebook.source.document,
		edition: rulebook.source.edition,
		retrieved: rulebook.source.retrieved,
		read: rulebook.source.documents,
		not_read: rulebook.source.documents_present_but_not_read,
		by_status,
		total: rulebook.rules.length,
	};
}
