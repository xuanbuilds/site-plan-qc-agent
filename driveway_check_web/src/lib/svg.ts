/** What an SVG declares about its own size, and whether that is enough to measure with. */

/** CSS absolute units, in px. An SVG length with one of these is a real paper size. */
const PX_PER_UNIT: Record<string, number> = {
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
	pt: 96 / 72,
	pc: 16,
	px: 1,
};

export type SvgLength = {
	value: number;
	unit: string;
	/** null when the unit is not a physical one (px, %, em, or none). */
	inches: number | null;
};

export type SvgInfo = {
	width: SvgLength | null;
	height: SvgLength | null;
	viewBox: { x: number; y: number; w: number; h: number } | null;
	/** User units per inch of paper. Needs both a physical width and a viewBox. */
	unitsPerInch: number | null;
	/** User units per real-world foot, and where that came from. Null when unknown. */
	pxPerFt: number | null;
	pxPerFtSource: string | null;
	elementCount: number;
	/** Every distinct element tag in the file, most frequent first. */
	tagCounts: [string, number][];
	/** Every distinct fill/stroke colour in the file. Used to grey the plan down
	 * around a selection without a CSS filter, which would grey the highlight too. */
	paints: string[];
};

function parseLength(raw: string | null): SvgLength | null {
	if (!raw) return null;
	const match = raw.trim().match(/^(-?[\d.]+)\s*([a-z%]*)$/i);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;
	const unit = match[2].toLowerCase() || "px";
	const px_per_unit = PX_PER_UNIT[unit];
	// px is a screen unit, not a paper unit, so it tells us nothing physical.
	const inches = px_per_unit && unit !== "px" ? (value * px_per_unit) / 96 : null;
	return { value, unit: match[2] || "(none)", inches };
}

/** Cedar's own exporter stamps the drawing scale on the root as data-px-per-ft.
 * That is the only place real-world scale has ever been found in a plan SVG, so
 * it is read explicitly rather than inferred. */
function readScale(svg: Element): { pxPerFt: number; source: string } | null {
	const declared = svg.getAttribute("data-px-per-ft");
	if (declared) {
		const value = Number(declared);
		if (Number.isFinite(value) && value > 0) return { pxPerFt: value, source: "data-px-per-ft" };
	}
	return null;
}

export function readSvg(text: string): { info: SvgInfo; svg: SVGSVGElement } | { error: string } {
	const doc = new DOMParser().parseFromString(text, "image/svg+xml");
	if (doc.querySelector("parsererror")) return { error: "This file is not valid XML." };

	const svg = doc.documentElement;
	if (svg.nodeName.toLowerCase() !== "svg") return { error: "The root element is not <svg>." };

	const raw_view_box = svg.getAttribute("viewBox");
	const parts = raw_view_box?.trim().split(/[\s,]+/).map(Number);
	const viewBox =
		parts?.length === 4 && parts.every(Number.isFinite)
			? { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
			: null;

	const width = parseLength(svg.getAttribute("width"));
	const height = parseLength(svg.getAttribute("height"));
	const scale = readScale(svg);

	const counts = new Map<string, number>();
	const paints = new Set<string>();
	const all = svg.querySelectorAll("*");
	all.forEach((el) => {
		const tag = el.nodeName.toLowerCase();
		counts.set(tag, (counts.get(tag) ?? 0) + 1);
		for (const name of ["fill", "stroke"]) {
			const value = el.getAttribute(name);
			if (value && /^#[0-9a-f]{3,8}$/i.test(value.trim())) paints.add(value.trim());
		}
	});

	return {
		svg: svg as unknown as SVGSVGElement,
		info: {
			width,
			height,
			viewBox,
			unitsPerInch: width?.inches && viewBox ? viewBox.w / width.inches : null,
			pxPerFt: scale?.pxPerFt ?? null,
			pxPerFtSource: scale?.source ?? null,
			elementCount: all.length,
			tagCounts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
			paints: [...paints],
		},
	};
}

/** Strip anything executable before the markup is inlined into the page.
 * Inlining (rather than an <img> blob) is what will let a later step hit-test
 * and tag individual elements; an <img> would be safe but opaque. */
export function sanitize(svg: SVGSVGElement): string
{
	const clone = svg.cloneNode(true) as SVGSVGElement;
	clone.querySelectorAll("script, foreignObject").forEach((el) => el.remove());
	clone.querySelectorAll("*").forEach((el) =>
	{
		for (const attr of [...el.attributes])
		{
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || (name === "href" && attr.value.trim().toLowerCase().startsWith("javascript:")))
			{
				el.removeAttribute(attr.name);
			}
		}
	});
	// Stamp the path index so a detected region can be highlighted and clicked.
	// Same order detectPaving walks, so the two agree without passing geometry around.
	clone.querySelectorAll("path").forEach((path, i) => path.setAttribute("data-idx", String(i)));

	// Let CSS drive the display size; the viewBox keeps the aspect ratio.
	clone.removeAttribute("width");
	clone.removeAttribute("height");
	return new XMLSerializer().serializeToString(clone);
}
