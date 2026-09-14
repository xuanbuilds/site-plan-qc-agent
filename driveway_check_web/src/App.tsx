import { useEffect, useState } from "react";
import { AlertTriangle, FileCode2, Ruler, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { read_svg, sanitize, type SvgInfo } from "@/lib/svg";
import { detect_paving, type Candidate, type Detection } from "@/lib/paving";
import { identify, type IdentifyResult } from "@/lib/identify";
import { coverage, evaluate, type Check, type Rulebook } from "@/lib/check/evaluate";
import { derive, propose_parking_angle, type Proposal, type SiteAnswers } from "@/lib/check/questions";

import { SvgDropzone } from "@/components/SvgDropzone";
import { PlanViewer } from "@/components/PlanViewer";
import { Button } from "@/components/ui/button";

type Loaded = {
	name: string;
	markup: string;
	info: SvgInfo;
	detection: Detection;
	/** The parsed document, kept so detection can be run again if the scale is
	 * measured after the fact - areas and perimeters are reported in feet. */
	svg: SVGSVGElement;
};

export default function App()
{
	const [loaded, set_loaded] = useState<Loaded | null>(null);
	const [selected, set_selected] = useState<number | null>(null);
	/** null = not answered yet, true = user confirmed, false = user rejected. */
	const [confirmed, set_confirmed] = useState<boolean | null>(null);
	const [features, set_features] = useState<IdentifyResult | null>(null);
	const [checks, set_checks] = useState<Check[] | null>(null);
	/** What the user has actually been asked, before anything is derived from it. */
	const [answers, set_answers] = useState<SiteAnswers>({});
	const [rulebook, set_rulebook] = useState<Rulebook | null>(null);
	/** Picking two points on the plan to establish its scale, and the distance
	 * between them in the drawing's own units once both are down. */
	const [calibrating, set_calibrating] = useState(false);
	const [span, set_span] = useState<number | null>(null);

	// The rulebook is static data, fetched once. Nothing consults a model at run
	// time - every verdict is a number against a number, with its citation.
	useEffect(() =>
	{
		fetch("/rules.austin-tcm.json")
			.then((response) => response.json())
			.then(set_rulebook)
			.catch(() => set_error("Could not load the rulebook."));
	}, []);
	const [error, set_error] = useState<string | null>(null);

	function open(name: string, text: string)
	{
		const result = read_svg(text);
		if ("error" in result)
		{
			set_error(result.error);
			return;
		}
		const detection = detect_paving(result.svg, result.info.px_per_ft);
		set_error(null);
		set_confirmed(null);
		set_features(null);
		set_checks(null);
		set_answers({});
		set_selected(detection.best?.index ?? null);
		set_calibrating(false);
		set_span(null);
		set_loaded({ name, markup: sanitize(result.svg), info: result.info, detection, svg: result.svg });
	}

	/** Adopt a scale measured off the drawing. Detection runs again because its
	 * areas and perimeters are in feet, and until now they were in drawing units. */
	function apply_scale(px_per_ft: number)
	{
		if (!loaded || !(px_per_ft > 0)) return;
		const detection = detect_paving(loaded.svg, px_per_ft);
		set_loaded({
			...loaded,
			info: { ...loaded.info, px_per_ft: px_per_ft, px_per_ft_source: "measured on the plan" },
			detection,
		});
		set_selected(detection.best?.index ?? null);
		set_confirmed(null);
		set_features(null);
		set_checks(null);
		set_calibrating(false);
		set_span(null);
	}

	function clear()
	{
		set_loaded(null);
		set_calibrating(false);
		set_span(null);
		set_selected(null);
		set_confirmed(null);
		set_features(null);
		set_checks(null);
	}

	/** Confirming the driveway runs identification immediately - there is nothing
	 * else the user would want to do at that point. Everything downstream is in
	 * feet, so the conversion happens once here rather than by scaling constants. */
	function confirm_driveway()
	{
		const px_per_ft = loaded?.info.px_per_ft;
		if (!region || !px_per_ft)
		{
			set_error("Cannot identify features without a scale.");
			return;
		}
		set_confirmed(true);
		try
		{
			const ring = region.points.map(([x, y]) => ({ x: x / px_per_ft, y: y / px_per_ft }));
			const result = identify(ring, { now: () => performance.now() });
			set_features(result);
			// No site parameters are supplied yet, so every conditioned rule reports
			// CANNOT_DETERMINE naming what it needs - which is the honest answer, not
			// a gap to paper over.
			set_checks(rulebook ? evaluate(rulebook, result.measurements, derive(answers)) : null);
			set_error(null);
		}
		catch (e)
		{
			set_features(null);
			set_error(e instanceof Error ? e.message : String(e));
		}
	}

	/** Rejecting clears the proposal and asks for a click, rather than guessing again. */
	function reject_driveway()
	{
		set_confirmed(false);
		set_selected(null);
		set_features(null);
		set_checks(null);
	}

	const region =
		loaded && selected !== null
			? loaded.detection.candidates.find((c) => c.index === selected) ?? null
			: null;

	// What the drawing itself can answer, offered for confirmation rather than
	// asked outright. Recomputed with the features, since that is where it is read.
	const proposals: Record<string, Proposal> = {};
	const angle = features && propose_parking_angle(features.stalls.map((s) => s.angle_to_aisle_deg));
	if (angle) proposals.parking_angle = angle;

	// Every filled region is selectable. Nothing on the sheet says which outline is
	// the property boundary, so nothing here decides what is off-site - see the note
	// on the missing site boundary in lib/paving.ts.
	const selectable = new Set((loaded?.detection.candidates ?? []).map((c) => c.index));

	return (
		<div className="flex h-screen flex-col">
			<header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">Driveway Checker</span>
					<span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						Web prototype
					</span>
				</div>
				{loaded && (
					<div className="flex items-center gap-3">
						<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<FileCode2 className="size-3.5" />
							{loaded.name}
						</span>
						<Button variant="ghost" size="sm" onClick={clear}>
							<X /> Clear
						</Button>
					</div>
				)}
			</header>

			{error && (
				<div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
					<AlertTriangle className="size-3.5 shrink-0" />
					{error}
				</div>
			)}

			{!loaded ? (
				<main className="flex flex-1 items-center justify-center p-8">
					<div className="w-full max-w-lg">
						<SvgDropzone onFile={open} onError={set_error} />
					</div>
				</main>
			) : (
				<main className="flex min-h-0 flex-1">
					<PlanViewer
						markup={loaded.markup}
						selected={selected}
						selectable={selectable}
						centroid={region?.centroid ?? null}
						paints={loaded.info.paints}
						confirmed={confirmed}
						features={features}
						checks={checks}
						px_per_ft={loaded.info.px_per_ft}
						calibrating={calibrating}
						on_span={set_span}
						answers={answers}
						proposals={proposals}
						on_answer={(key, value) =>
						{
							// Re-run the whole rulebook, not just the check that asked: one
							// answer often resolves several rules at once, and land use alone
							// settles driveway class without ever asking for it.
							const next = { ...answers, [key]: value };
							set_answers(next);
							if (features && rulebook)
							{
								set_checks(evaluate(rulebook, features.measurements, derive(next)));
							}
						}}
						on_confirm={confirm_driveway}
						on_reject={reject_driveway}
						on_select={(i) =>
						{
							// Picking a region re-opens the question rather than answering it -
							// the user still has to confirm that this is the driveway.
							set_selected(i);
							set_confirmed(null);
							set_features(null);
						}}
					/>
					<aside className="w-80 shrink-0 overflow-auto border-l border-border p-4">
						<Declares
							info={loaded.info}
							calibrating={calibrating}
							span={span}
							on_start={() => { set_calibrating(true); set_span(null); }}
							on_cancel={() => set_calibrating(false)}
							on_apply={apply_scale}
						/>
						<div className="mt-5 border-t border-border pt-5">
							<Paving
								detection={loaded.detection}
								region={region}
								confirmed={confirmed === true}
								scaled={loaded.info.px_per_ft !== null}
							/>
						</div>
						{rulebook && (
							<div className="mt-5 border-t border-border pt-5">
								<Corpus rulebook={rulebook} />
							</div>
						)}
					</aside>
				</main>
			)}
		</div>
	);
}

function Paving({
	detection,
	region,
	confirmed,
	scaled,
}: { detection: Detection; region: Candidate | null; confirmed: boolean; scaled: boolean })
{
	const runner_up = detection.candidates.find((c) => c.index !== detection.best?.index);
	const margin =
		detection.best && runner_up && runner_up.score > 0
			? detection.best.score / runner_up.score
			: null;

	return (
		<div>
			<h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Paving
			</h2>

			{!region ? (
				<p className="mt-3 text-xs text-muted-foreground">
					{detection.best
						? "Nothing selected. Click a region on the plan."
						: "No filled closed region found."}
				</p>
			) : (
				<>
					<dl className="mt-3 flex flex-col gap-2 text-xs">
						<Row
							label="Found by"
							value={
								confirmed
									? "you"
									: detection.method === "tagged"
										? "tag"
										: `rank 1 of ${detection.candidates.length}`
							}
						/>
						{!confirmed && detection.method === "ranked" && margin && (
							<Row label="Margin over 2nd" value={`${margin.toFixed(1)}x`} />
						)}
						{/* Without a scale these are the drawing's own units, and a plan that
						    declares none - option_4 - would otherwise read as a 64,000 sf drive. */}
						<Row label="Area" value={`${Math.round(region.area).toLocaleString()} ${scaled ? "sf" : "units²"}`} />
						<Row label="Perimeter" value={`${Math.round(region.perimeter)} ${scaled ? "ft" : "units"}`} />
					</dl>
				</>
			)}
		</div>
	);
}

type DeclaresProps = {
	info: SvgInfo;
	calibrating: boolean;
	/** Distance between the two picked points, in the drawing's own units. */
	span: number | null;
	on_start: () => void;
	on_cancel: () => void;
	on_apply: (px_per_ft: number) => void;
};

function Declares({ info, calibrating, span, on_start, on_cancel, on_apply }: DeclaresProps)
{
	const paper =
		info.width?.inches && info.height?.inches
			? `${info.width.value}${info.width.unit} x ${info.height.value}${info.height.unit}`
			: null;

	const extent =
		info.px_per_ft && info.viewBox
			? `${round(info.viewBox.w / info.px_per_ft)} x ${round(info.viewBox.h / info.px_per_ft)} ft`
			: null;

	return (
		<div className="flex flex-col gap-5">
			<div>
				<h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					SVG info
				</h2>
				<dl className="mt-3 flex flex-col gap-2 text-xs">
					<Row label="Paper size" value={paper ?? "no physical units"} muted={!paper} />
					<Row
						label="viewBox"
						value={info.viewBox ? `${round(info.viewBox.w)} x ${round(info.viewBox.h)}` : "none"}
						muted={!info.viewBox}
					/>
					<Row
						label="Scale"
						value={info.px_per_ft ? `${info.px_per_ft.toFixed(4)} px/ft` : "not declared"}
						warn={!info.px_per_ft}
					/>
					{info.px_per_ft_source && (
						<Row
							label="Scale source"
							value={info.px_per_ft_source}
							monoValue={info.px_per_ft_source.startsWith("data-")}
						/>
					)}
					<Row label="Site extent" value={extent ?? "unknown"} muted={!extent} />
					<Row label="Elements" value={info.element_count.toString()} />
				</dl>

				{calibrating ? (
					<Calibrate info={info} span={span} on_cancel={on_cancel} on_apply={on_apply} />
				) : (
					<Button variant="outline" size="sm" className="mt-3 w-full" onClick={on_start}>
						<Ruler /> {info.px_per_ft ? "Re-measure scale" : "Measure the scale"}
					</Button>
				)}
			</div>

			<div>
				<h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Contents
				</h2>
				<dl className="mt-3 flex flex-col gap-1.5 text-xs">
					{info.tag_counts.slice(0, 12).map(([tag, count]) => (
						<Row key={tag} label={tag} value={count.toString()} mono />
					))}
				</dl>
			</div>
		</div>
	);
}

/** Establishing the scale by measuring something on the drawing whose real size is
 * known.
 *
 * Only Cedar's own exporter stamps data-px-per-ft, so for a plan from anywhere
 * else this is the only way to get from drawing units to feet. Every constant in
 * the identification pipeline is an absolute distance in feet, so without it
 * nothing downstream can run at all — and a scale that is merely close produces
 * plausible, wrong verdicts rather than an obvious failure.
 *
 * Two points and a distance covers every case a site plan offers, because they
 * are all the same measurement: the ends of a drawn dimension line, the ends of a
 * scale bar, or across a parking stall. Zoom in first — the picks are taken in
 * the drawing's coordinates, so accuracy is limited only by how close you get. */
function Calibrate({
	info,
	span,
	on_cancel,
	on_apply,
}: { info: SvgInfo; span: number | null; on_cancel: () => void; on_apply: (px_per_ft: number) => void })
{
	const [feet, set_feet] = useState("");
	const entered = Number(feet);
	const proposed = span && entered > 0 ? span / entered : null;

	// The extent this scale would imply, shown live. A site that comes out 40 ft
	// across or 4 miles across is a misplaced decimal, and seeing it here costs
	// nothing — whereas noticing it from the verdicts costs the whole run.
	const extent =
		proposed && info.viewBox
			? `${round(info.viewBox.w / proposed)} x ${round(info.viewBox.h / proposed)} ft`
			: null;

	return (
		<div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
			<p className="text-xs leading-relaxed text-muted-foreground">
				{span
					? "Now give the real distance between the two points."
					: "Click two points on the plan whose real distance you know — the ends of a dimension line, a scale bar, or across a parking stall."}
			</p>

			<div className="mt-2.5 flex items-center gap-1.5">
				<input
					type="number"
					inputMode="decimal"
					min="0"
					step="any"
					value={feet}
					disabled={!span}
					onChange={(e) => set_feet(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && proposed) on_apply(proposed); }}
					placeholder="0"
					className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
				/>
				<span className="text-xs text-muted-foreground">ft</span>
			</div>

			{extent && (
				<dl className="mt-2.5 flex flex-col gap-1.5 text-xs">
					<Row label="Scale" value={`${proposed!.toFixed(4)} px/ft`} />
					<Row label="Site extent" value={extent} />
				</dl>
			)}

			<div className="mt-2.5 flex gap-1.5">
				<Button size="sm" disabled={!proposed} onClick={() => proposed && on_apply(proposed)}>
					Apply
				</Button>
				<Button size="sm" variant="ghost" onClick={on_cancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

type RowProps = {
	label: string;
	value: string;
	/** Value is absent or not applicable. */
	muted?: boolean;
	/** Label is a code identifier (element tag names). */
	mono?: boolean;
	/** Value is a code identifier (attribute names). */
	monoValue?: boolean;
	/** Value is a missing input that blocks measurement. */
	warn?: boolean;
};

function Row({ label, value, muted, mono, monoValue, warn }: RowProps)
{
	return (
		<div className="flex items-baseline justify-between gap-3">
			<dt className={mono ? "font-mono text-muted-foreground" : "text-muted-foreground"}>{label}</dt>
			<dd
				className={cn(
					muted ? "text-muted-foreground/60" : "font-medium",
					monoValue && "font-mono",
					warn && "text-warning-foreground"
				)}
			>
				{value}
			</dd>
		</div>
	);
}

function round(n: number)
{
	return Math.round(n * 100) / 100;
}

/** What the checks were run against — and what was deliberately not consulted.
 *
 * A clean result is only trustworthy if you can see how much was examined to get
 * it, so the coverage split and the unread sources are shown alongside. */
function Corpus({ rulebook }: { rulebook: Rulebook })
{
	const c = coverage(rulebook);
	const rows = [
		...c.read.map((doc) => ({ title: doc.title, status: "read in full" })),
		...c.not_read.map((doc) => ({
			title: doc.file.replace(/.docx$/, ""),
			status: "not consulted",
		})),
	];

	return (
		<div>
			<h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Corpus
			</h2>
			<table className="mt-3 w-full text-xs">
				<tbody>
					{rows.map((row, i) => (
						<tr key={row.title} className="align-top">
							<td className="w-14 py-1 pr-2 text-muted-foreground">
								{i === 0 ? c.jurisdiction.replace("City of ", "") : ""}
							</td>
							<td className="py-1 pr-2">{row.title}</td>
							<td className="w-24 py-1 text-right text-muted-foreground">{row.status}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
