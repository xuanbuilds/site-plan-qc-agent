import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check as CheckIcon, Maximize2, Minus, MousePointerClick, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpeechBubble } from "@/components/SpeechBubble";
import type { IdentifyResult } from "@/lib/identify";
import type { Check } from "@/lib/check/evaluate";
import { next_question, type Proposal, type SiteAnswers } from "@/lib/check/questions";

/** Fit-to-page. Zooming out past this would only add whitespace on all four sides. */
const MIN_SCALE = 1;
const MAX_SCALE = 60;
/** One wheel notch. Small enough that a trackpad's many small deltas feel smooth. */
const ZOOM_RATE = 0.0015;
/** Pointer travel below this still counts as a click, not a drag. */
const CLICK_SLOP_PX = 4;

type View = { scale: number; x: number; y: number };
type Size = { width: number; height: number };

const FIT: View = { scale: 1, x: 0, y: 0 };

/** The overlay has to sit in the plan's own coordinate space, which means sharing
 * its viewBox — reading it off the markup is cheaper than threading it through. */
function svg_view_box(markup: string): string
{
	return markup.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 100 100";
}

/** Keep the plan covering the frame. At fit scale the allowed range collapses to a
 * single point, so the drawing simply cannot be dragged off into blank space;
 * zoomed in, panning stops at its own edges. */
function contain(v: View, frame: Size): View
{
	return {
		scale: v.scale,
		x: Math.min(0, Math.max(frame.width * (1 - v.scale), v.x)),
		y: Math.min(0, Math.max(frame.height * (1 - v.scale), v.y)),
	};
}

/** Perceptual grey for a hex colour. Rewriting each paint beats a CSS filter,
 * which would grey the highlight along with everything else. */
function to_grey(hex: string): string
{
	const raw = hex.replace("#", "");
	const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw.slice(0, 6);
	const n = Number.parseInt(full, 16);
	if (!Number.isFinite(n)) return hex;
	const level = Math.round(
		0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
	);
	const two = level.toString(16).padStart(2, "0");
	return `#${two}${two}${two}`;
}

/** Alternative branches of one provision collapse into a single pending line.
 *
 * TCM 9.3.4.2.H carries both the two-way minimum (20 ft) and the one-way minimum
 * (10 ft). Until traffic direction is known BOTH are unresolved, so both were
 * being listed — which reads as a duplicate bug rather than as one question. Only
 * one can ever apply, so while a check is pending, same provision plus same
 * dimension is one row. Once answered, the inapplicable branch drops out on its
 * own and the survivor shows its real threshold. */
function collapse_pending(checks: readonly Check[]): Check[]
{
	const out: Check[] = [];
	const seen = new Map<string, Check>();
	for (const check of checks)
	{
		if (check.verdict !== "CANNOT_DETERMINE" || check.missing.length === 0)
		{
			out.push(check);
			continue;
		}
		// Keyed on the measurement too, not just the provision. An apron has two curb
		// returns, both governed by Table 7-1 and both pending the same two answers —
		// but they are two different arcs, and if they differ, folding them together
		// would show one radius and hide the other.
		const key = `${check.cite.section}|${check.dimension}|${check.measured_ft?.toFixed(2)}`;
		const existing = seen.get(key);
		if (!existing)
		{
			const copy = { ...check, missing: [...check.missing] };
			seen.set(key, copy);
			out.push(copy);
			continue;
		}
		// Keep the union of what the branches need, so nothing goes unasked.
		for (const needed of check.missing)
		{
			if (!existing.missing.includes(needed)) existing.missing.push(needed);
		}
	}
	return out;
}

const VERDICT_STYLE: Record<string, string> = {
	PASS: "text-success",
	FAIL: "text-destructive",
	CANNOT_DETERMINE: "text-warning-foreground",
};

type Props = {
	markup: string;
	/** Path index of the selected paving, or null for the untouched drawing. */
	selected: number | null;
	/** Path indices a click may select. Everything else is context. */
	selectable: Set<number>;
	/** Area centroid of the selected region, in SVG user units. */
	centroid: [number, number] | null;
	/** Every distinct fill/stroke in the file, so they can be neutralised. */
	paints: string[];
	/** null = not answered, true = confirmed, false = rejected. */
	confirmed: boolean | null;
	features: IdentifyResult | null;
	checks: Check[] | null;
	/** SVG user units per foot, to place feet-space geometry on the drawing. */
	px_per_ft: number | null;
	/** Picking two points to establish the scale, rather than selecting regions. */
	calibrating: boolean;
	/** Distance between the two picked points, in SVG user units. Null while fewer
	 * than two are down. */
	on_span: (svg_units: number | null) => void;
	on_select: (index: number | null) => void;
	on_confirm: () => void;
	on_reject: () => void;
	/** Answers so far, so a derived question knows what has already been said. */
	answers: SiteAnswers;
	/** Answers the geometry can offer for confirmation instead of asking outright. */
	proposals: Record<string, Proposal>;
	/** Answer to a question the geometry could not settle. */
	on_answer: (key: string, value: unknown) => void;
};

export function PlanViewer({
	markup,
	selected,
	selectable,
	centroid,
	paints,
	confirmed,
	features,
	checks,
	px_per_ft,
	calibrating,
	on_span,
	on_select,
	on_confirm,
	on_reject,
	answers,
	proposals,
	on_answer,
}: Props)
{
	const [view, set_view] = useState<View>(FIT);
	const [grabbing, set_grabbing] = useState(false);
	/** Proposals the user rejected. They fall back to the plain question, and only
	 * for this plan - a rejection says the reading was wrong here, not that the
	 * measurement should stop being offered. */
	const [declined, set_declined] = useState<ReadonlySet<string>>(new Set());
	const decline = useCallback(
		(key: string) => set_declined((prior) => new Set(prior).add(key)),
		[]
	);
	/** The two points being measured, in the drawing's own units, plus where the
	 * cursor is so the second leg can rubber-band before it is committed. */
	const [picks, set_picks] = useState<{ x: number; y: number }[]>([]);
	const [hover, set_hover] = useState<{ x: number; y: number } | null>(null);
	const [anchor, set_anchor] = useState<{ x: number; y: number } | null>(null);
	/** Bumped whenever the frame resizes, to re-run the layout-dependent effects. */
	const [resized, set_resized] = useState(0);
	const [label_anchors, set_label_anchors] = useState<
		{ x: number; y: number; index: number; label: IdentifyResult["labels"][number] }[]
	>([]);
	const frame = useRef<HTMLDivElement>(null);
	const dragging = useRef<{ x: number; y: number; downX: number; downY: number } | null>(null);

	const grey_rules = useMemo(
		() =>
			paints
				.map((p) => `svg [fill="${p}"]{fill:${to_grey(p)}}svg [stroke="${p}"]{stroke:${to_grey(p)}}`)
				.join(""),
		[paints]
	);

	/** A screen position in the drawing's own coordinates.
	 *
	 * The inlined plan's root <svg> is the one element that knows this mapping: its
	 * screen matrix already folds in the viewBox, the letterboxing that fits it to
	 * the pane, and the wrapper's pan-and-zoom transform. Inverting it is exact, so
	 * a pick lands where the user clicked at any zoom. */
	const drawing_point = useCallback((client_x: number, client_y: number) =>
	{
		const svg = frame.current?.querySelector("svg") as SVGSVGElement | null;
		const ctm = svg?.getScreenCTM?.();
		if (!ctm) return null;
		const point = new DOMPoint(client_x, client_y).matrixTransform(ctm.inverse());
		return { x: point.x, y: point.y };
	}, []);

	// Leaving calibration drops the picks: they only mean anything alongside the
	// distance the user is being asked for.
	useEffect(() =>
	{
		if (!calibrating) { set_picks([]); set_hover(null); }
	}, [calibrating]);

	/** Zoom about a point so whatever is under the cursor stays under the cursor. */
	const zoom_at = useCallback((client_x: number, client_y: number, factor: number) =>
	{
		const rect = frame.current?.getBoundingClientRect();
		if (!rect) return;
		const cx = client_x - rect.left;
		const cy = client_y - rect.top;
		set_view((v) =>
		{
			const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
			const ratio = scale / v.scale;
			return contain({ scale, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio }, rect);
		});
	}, []);

	// React attaches onWheel passively, so preventDefault there is ignored and the
	// page scrolls behind the zoom. A native non-passive listener is the only fix.
	useEffect(() =>
	{
		const el = frame.current;
		if (!el) return;
		const on_wheel = (e: WheelEvent) =>
		{
			e.preventDefault();
			zoom_at(e.clientX, e.clientY, Math.exp(-e.deltaY * ZOOM_RATE));
		};
		el.addEventListener("wheel", on_wheel, { passive: false });
		return () => el.removeEventListener("wheel", on_wheel);
	}, [zoom_at]);

	// A pointerup can be missed — released off-window, or swallowed by the browser's
	// native drag on the inline SVG — which leaves the grab stuck on. Ending the drag
	// from the window guarantees it always clears.
	useEffect(() =>
	{
		const end = () => { dragging.current = null; set_grabbing(false); };
		window.addEventListener("pointerup", end);
		window.addEventListener("pointercancel", end);
		return () =>
		{
			window.removeEventListener("pointerup", end);
			window.removeEventListener("pointercancel", end);
		};
	}, []);

	// Both callouts track the plan's own coordinates, so they stay put through any
	// pan or zoom. getScreenCTM does the SVG-units-to-pixels mapping, which is the
	// only thing that survives the wrapper's CSS transform.
	useLayoutEffect(() =>
	{
		const box = frame.current;
		const el =
			selected === null
				? null
				: (box?.querySelector(`[data-idx="${selected}"]`) as SVGGraphicsElement | null);
		const ctm = el?.getScreenCTM?.();
		if (!box || !ctm)
		{
			set_anchor(null);
			set_label_anchors([]);
			return;
		}
		const rect = box.getBoundingClientRect();
		const to_screen = (x: number, y: number) =>
		{
			const p = new DOMPoint(x, y).matrixTransform(ctm);
			return { x: p.x - rect.left, y: p.y - rect.top };
		};

		set_anchor(centroid ? to_screen(centroid[0], centroid[1]) : null);
		set_label_anchors(
			features && px_per_ft
				? features.labels.map((label, index) => ({
						...to_screen(label.at.x * px_per_ft, label.at.y * px_per_ft),
						index,
						label,
					}))
				: []
		);
	}, [selected, centroid, features, px_per_ft, view, markup, resized]);

	// Resizing the pane moves the drawing without changing scale or offset, so the
	// callout anchors and the pan clamp both go stale unless the frame tells us.
	useEffect(() =>
	{
		const el = frame.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() =>
		{
			set_resized((n) => n + 1);
			set_view((v) => contain(v, el.getBoundingClientRect()));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	function zoom_centre(factor: number)
	{
		const rect = frame.current?.getBoundingClientRect();
		if (!rect) return;
		zoom_at(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
	}

	const overlay_transform = {
		transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
		transformOrigin: "0 0",
	};

	return (
		<section className="relative min-w-0 flex-1 overflow-hidden bg-muted/40">
			{/* Nothing is greyed while measuring: a dimension line or scale bar is
			    usually drawn in one of the colours that would be flattened away. */}
			{selected !== null && !calibrating && (
				<style>{`
					${grey_rules}
					svg [data-idx="${selected}"]{
						fill:var(--color-landing);
						stroke:var(--color-foreground);
						stroke-width:2;
					}
				`}</style>
			)}
			<div
				ref={frame}
				className="relative h-full w-full touch-none select-none overflow-hidden"
				style={{ cursor: calibrating ? "crosshair" : grabbing ? "grabbing" : "grab" }}
				onDragStart={(e) => e.preventDefault()}
				onPointerDown={(e) =>
				{
					dragging.current = {
						x: e.clientX - view.x,
						y: e.clientY - view.y,
						downX: e.clientX,
						downY: e.clientY,
					};
					set_grabbing(true);
				}}
				onPointerMove={(e) =>
				{
					if (calibrating && picks.length === 1) set_hover(drawing_point(e.clientX, e.clientY));
					const from = dragging.current;
					const rect = frame.current?.getBoundingClientRect();
					if (!from || !rect) return;
					set_view((v) => contain({ ...v, x: e.clientX - from.x, y: e.clientY - from.y }, rect));
				}}
				onClick={(e) =>
				{
					const from = dragging.current;
					if (from && Math.hypot(e.clientX - from.downX, e.clientY - from.downY) > CLICK_SLOP_PX) return;

					if (calibrating)
					{
						const point = drawing_point(e.clientX, e.clientY);
						if (!point) return;
						// A third click starts over rather than doing nothing, so a misplaced
						// pick is corrected by carrying on instead of by finding a reset.
						const next = picks.length >= 2 ? [point] : [...picks, point];
						set_picks(next);
						set_hover(null);
						on_span(
							next.length === 2
								? Math.hypot(next[1].x - next[0].x, next[1].y - next[0].y)
								: null
						);
						return;
					}

					const hit = (e.target as Element)?.closest?.("[data-idx]");
					const raw = hit?.getAttribute("data-idx");
					if (raw === null || raw === undefined) { on_select(null); return; }
					const index = Number(raw);
					// Off-site regions stay inert rather than selectable.
					if (selectable.has(index)) on_select(index);
				}}
			>
				<div
					className="absolute inset-0 flex items-center justify-center [&>svg]:max-h-full [&>svg]:max-w-full"
					style={overlay_transform}
					// Sanitized in sanitize(): scripts, foreignObject, on* and javascript: hrefs removed.
					dangerouslySetInnerHTML={{ __html: markup }}
				/>

				{/* The measuring line, drawn in the plan's own coordinates so it stays on
				    the features it was placed against through any pan or zoom. Strokes
				    are non-scaling so a zoomed-in pick stays a hairline to aim with. */}
				{calibrating && picks.length > 0 && (
					<div
						className="pointer-events-none absolute inset-0 flex items-center justify-center [&>svg]:max-h-full [&>svg]:max-w-full"
						style={overlay_transform}
					>
						<svg viewBox={svg_view_box(markup)} className="overflow-visible">
							{(() =>
							{
								const end = picks[1] ?? hover;
								return (
									<>
										{end && (
											<line
												x1={picks[0].x}
												y1={picks[0].y}
												x2={end.x}
												y2={end.y}
												stroke="var(--color-destructive)"
												strokeWidth={2}
												strokeDasharray={picks[1] ? undefined : "6 4"}
												vectorEffect="non-scaling-stroke"
											/>
										)}
										{[picks[0], picks[1]].map((p, i) =>
											p ? (
												<circle
													key={i}
													cx={p.x}
													cy={p.y}
													r={4}
													fill="var(--color-destructive)"
													stroke="var(--color-background)"
													strokeWidth={1.5}
													vectorEffect="non-scaling-stroke"
													// r is in drawing units, so without this the dots balloon
													// as you zoom in to aim.
													style={{ transform: `scale(${1 / view.scale})`, transformBox: "fill-box", transformOrigin: "center" }}
												/>
											) : null
										)}
									</>
								);
							})()}
						</svg>
					</div>
				)}

				{/* Findings are hidden while measuring: their bubbles sit over the plan
				    and would take the clicks, and a re-measure makes them stale anyway. */}
				{features && px_per_ft && !calibrating && (
					<div
						className="pointer-events-none absolute inset-0 flex items-center justify-center [&>svg]:max-h-full [&>svg]:max-w-full"
						style={overlay_transform}
					>
						<svg viewBox={svg_view_box(markup)} className="overflow-visible">
							{features.delineation.map((line, i) => (
								<line
									key={i}
									x1={line.from.x * px_per_ft}
									y1={line.from.y * px_per_ft}
									x2={line.to.x * px_per_ft}
									y2={line.to.y * px_per_ft}
									stroke="var(--color-foreground)"
									strokeWidth={3}
									strokeDasharray="10 7"
									strokeLinecap="round"
								/>
							))}
						</svg>
					</div>
				)}

				{!calibrating && label_anchors.map((a) =>
				{
					const region_checks = collapse_pending(
						(checks ?? []).filter((c) => c.region_index === a.index)
					);
					// Ask rather than let the user decode CANNOT_DETERMINE. One question at
					// a time, because answering one often resolves several checks at once.
					const question = next_question(
						region_checks.flatMap((c) => c.missing),
						answers,
						proposals,
						declined
					);
					return (
						<SpeechBubble
							key={a.index}
							x={a.x}
							y={a.y}
							side="left"
							width={region_checks.length > 0 ? 232 : 112}
						>
							<p className="text-xs font-medium leading-tight">{a.label.category}</p>
							{region_checks.map((check, i) => (
								<div key={i} className="mt-1.5 border-t border-border pt-1.5">
									<p className={`text-[11px] font-medium leading-tight ${VERDICT_STYLE[check.verdict]}`}>
										{check.verdict.replace("_", " ")}
									</p>
									<p className="text-[11px] leading-tight">
										{check.dimension.replace("_", " ")}{" "}
										{check.measured_ft !== null ? `${check.measured_ft.toFixed(1)} ft` : "—"} vs{" "}
										{check.requirement}
									</p>
									<p className="text-[10px] leading-tight text-muted-foreground">
										{check.cite.section} — {check.reason}
									</p>
								</div>
							))}
							{question && (
								<div
									className="pointer-events-auto mt-2 border-t border-border pt-2"
									onClick={(e) => e.stopPropagation()}
								>
									{/* When the drawing already answers the question, it is put the
									    same way the driveway itself is: a claim with Confirm and
									    Reject, not a menu. Rejecting drops through to the options. */}
									<p className="text-[11px] leading-tight">
										{question.proposal?.statement ?? question.prompt}
									</p>
									<div className="mt-1.5 flex flex-wrap gap-1.5">
										{question.proposal ? (
											<>
												<Button
													size="sm"
													onClick={() => on_answer(question.key, question.proposal!.value)}
												>
													<CheckIcon /> Confirm
												</Button>
												<Button
													size="sm"
													variant="outline"
													onClick={() => decline(question.key)}
												>
													<X /> Reject
												</Button>
											</>
										) : (
											question.options.map((option) => (
												<Button
													key={option.label}
													size="sm"
													variant="outline"
													onClick={() => on_answer(question.key, option.value)}
												>
													{option.label}
												</Button>
											))
										)}
									</div>
								</div>
							)}
						</SpeechBubble>
					);
				})}

				{anchor && confirmed !== true && !calibrating && (
					<SpeechBubble x={anchor.x} y={anchor.y} side="left" width={214}>
						<p className="text-xs leading-relaxed">Driveway found.</p>
						{/* The bubble sits inside the frame, so a button click also reaches the
						    frame's click handler — which treats any click off a region as
						    "deselect" and would undo the answer immediately. */}
						<div
							className="pointer-events-auto mt-2 flex gap-1.5"
							onClick={(e) => e.stopPropagation()}
						>
							<Button size="sm" onClick={on_confirm}>
								<CheckIcon /> Confirm
							</Button>
							<Button size="sm" variant="outline" onClick={on_reject}>
								<X /> Reject
							</Button>
						</div>
					</SpeechBubble>
				)}

				{confirmed === false && (
					<div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
						<div className="flex items-center gap-1.5 rounded-lg border border-border bg-card/95 px-3 py-2 shadow-lg backdrop-blur">
							<MousePointerClick className="size-3.5 shrink-0 text-muted-foreground" />
							<p className="text-xs">Click the driveway on the plan.</p>
						</div>
					</div>
				)}
			</div>

			<div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-border bg-card/90 p-1 backdrop-blur">
				<Button variant="ghost" size="sm" onClick={() => zoom_centre(1 / 1.4)} title="Zoom out">
					<Minus />
				</Button>
				<span className="w-12 text-center font-mono text-xs text-muted-foreground">
					{Math.round(view.scale * 100)}%
				</span>
				<Button variant="ghost" size="sm" onClick={() => zoom_centre(1.4)} title="Zoom in">
					<Plus />
				</Button>
				<Button variant="ghost" size="sm" onClick={() => set_view(FIT)} title="Fit to window">
					<Maximize2 />
				</Button>
			</div>
		</section>
	);
}
