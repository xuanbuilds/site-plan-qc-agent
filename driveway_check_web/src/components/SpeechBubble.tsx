import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Callout shape ported from the Rhino bubble construction.
 *
 * A rounded rectangle whose bottom corner on the tail side is not rounded: that
 * edge runs straight down past the body into a sharp tip, then a diagonal
 * returns to the bottom edge with a small fillet at the junction. The tip is the
 * anchor, so the caller positions by the point rather than by the box.
 *
 * Proportions follow the original, expressed against `h` (the text size) so the
 * bubble scales as one piece. */

/** Text size the proportions are derived from. */
const H = 12;
const PAD_X = 1.6 * H;
const PAD_Y = 1.2 * H;
/** Tail drop below the body. */
const DROP = 1.3 * H;
/** Tail run along the bottom edge. */
const RUN = 1.3 * H;
/** Fillet where the tail meets the body. */
const JOINT = 0.6 * H;

export type BubbleSide = "left" | "right";

/** Build the outline with the tip at (0,0) and the body above it.
 * `width`/`height` are the body's size in px; y is negative going up. */
function outline(width: number, height: number, side: BubbleSide): string
{
	const r = Math.min(H, Math.min(width, height) * 0.45);
	const run = Math.min(RUN, width - r - 0.1 * H);
	const y_bottom = -DROP;
	const y_top = -(DROP + height);

	// Mirror the whole construction for a right-hand tail, so the maths below
	// only ever has to describe the left-hand case.
	const flip = side === "right" ? -1 : 1;
	const fx = (x: number) => x * flip;

	// Virtual corner where the tail would meet the bottom edge, then the two
	// tangent points of the fillet that replaces that corner.
	const cx = run;
	const cy = y_bottom;
	const ux = -run;
	const uy = DROP;
	const len = Math.hypot(ux, uy);
	const u = [ux / len, uy / len];
	const theta = Math.acos(Math.max(-1, Math.min(1, u[0])));
	let t = JOINT / Math.tan(theta / 2);
	t = Math.min(t, len * 0.8, (width - r - cx) * 0.8);
	const t1 = [cx + u[0] * t, cy + u[1] * t];
	const t2 = [cx + t, cy];

	const p = (x: number, y: number) => `${fx(x).toFixed(2)} ${y.toFixed(2)}`;
	// Mirroring reverses handedness, so every arc sweep flips with it.
	const sweep = side === "right" ? 1 : 0;
	const joint_sweep = side === "right" ? 0 : 1;

	return [
		`M ${p(t2[0], t2[1])}`,
		`L ${p(width - r, y_bottom)}`,
		`A ${r} ${r} 0 0 ${sweep} ${p(width, y_bottom - r)}`,
		`L ${p(width, y_top + r)}`,
		`A ${r} ${r} 0 0 ${sweep} ${p(width - r, y_top)}`,
		`L ${p(r, y_top)}`,
		`A ${r} ${r} 0 0 ${sweep} ${p(0, y_top + r)}`,
		`L ${p(0, 0)}`,
		`L ${p(t1[0], t1[1])}`,
		`A ${JOINT} ${JOINT} 0 0 ${joint_sweep} ${p(t2[0], t2[1])}`,
		"Z",
	].join(" ");
}

type Props = {
	/** Anchor in pixels relative to the positioned parent. The tip lands here. */
	x: number;
	y: number;
	side?: BubbleSide;
	/** Body width in px. Height is measured from the content. */
	width?: number;
	children: ReactNode;
};

export function SpeechBubble({ x, y, side = "left", width = 190, children }: Props)
{
	const content = useRef<HTMLDivElement>(null);
	const [height, set_height] = useState(0);

	useLayoutEffect(() =>
	{
		const measured = content.current?.offsetHeight ?? 0;
		if (measured > 0) set_height(measured + 2 * PAD_Y);
	});

	const body = Math.max(height, H + 2 * PAD_Y);
	const total_w = width;
	const total_h = body + DROP;
	// The tip sits at the bottom-left of the drawn box (bottom-right when mirrored).
	const left = side === "right" ? x - total_w : x;

	return (
		<div
			className="pointer-events-none absolute z-10"
			style={{ left, top: y - total_h, width: total_w, height: total_h }}
		>
			<svg
				className="absolute inset-0 overflow-visible"
				width={total_w}
				height={total_h}
				viewBox={`${side === "right" ? -total_w : 0} ${-total_h} ${total_w} ${total_h}`}
			>
				<path
					d={outline(total_w, body, side)}
					fill="var(--color-card)"
					stroke="var(--color-border)"
					strokeWidth="1"
					strokeLinejoin="round"
				/>
			</svg>
			<div
				ref={content}
				className="absolute"
				style={{ left: PAD_X * 0.55, right: PAD_X * 0.55, top: PAD_Y * 0.5 }}
			>
				{children}
			</div>
		</div>
	);
}
