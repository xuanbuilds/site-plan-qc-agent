/** Headless identification of one plan, for diagnosis outside the browser.
 *
 *   npx tsx scripts/identify_file.ts "<path to svg>" [px_per_ft]
 *
 * The browser tool finds the drive through the real paving detector, which
 * needs the DOM. This needs none of that: it takes the largest closed shape
 * drawn in the cedarOS drive colour - by stylesheet class or by attribute -
 * converts it to feet and hands it to identify(): the same pipeline, the same
 * constants. The scale comes from the argument, or from data-px-per-ft when the
 * file declares one. Prints one JSON object. */

import { readFileSync } from "node:fs";
import { identify } from "../src/lib/identify/index";
import { oriented_box } from "../src/lib/identify/oriented-box";

const DRIVE_FILL = /#4d4d4d/i;
const NUMBER = /-?\d+\.?\d*(?:e[+-]?\d+)?/gi;

const [, , file, scale_arg] = process.argv;
if (!file) { console.error("usage: npx tsx scripts/identify_file.ts <svg> [px_per_ft]"); process.exit(2); }
const text = readFileSync(file, "utf8");

const declared = Number((text.match(/data-px-per-ft="([^"]+)"/) ?? [])[1]);
const px_per_ft = scale_arg ? Number(scale_arg) : declared;
if (!(px_per_ft > 0)) { console.log(JSON.stringify({ error: "no scale: file declares none, pass px_per_ft" })); process.exit(1); }

// Classes whose stylesheet rule fills with the drive colour.
const drive_classes = new Set<string>();
for (const style of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
{
	for (const rule of style[1].matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g))
	{
		if (/fill\s*:\s*#4d4d4d/i.test(rule[2])) drive_classes.add(rule[1]);
	}
}

type Ring = { x: number; y: number }[];
const rings: Ring[] = [];
const to_ring = (nums: number[]): Ring | null =>
{
	if (nums.length < 6) return null;
	const ring: Ring = [];
	for (let i = 0; i + 1 < nums.length; i += 2) ring.push({ x: nums[i], y: nums[i + 1] });
	return ring;
};
for (const m of text.matchAll(/<polyline\b([^>]*)>/g))
{
	const cls = (m[1].match(/class="([^"]*)"/) ?? [])[1] ?? "";
	const attr_fill = (m[1].match(/\bfill="([^"]*)"/) ?? [])[1] ?? "";
	if (!cls.split(/\s+/).some((c) => drive_classes.has(c)) && !DRIVE_FILL.test(attr_fill)) continue;
	const ring = to_ring(((m[1].match(/points="([^"]*)"/) ?? [])[1] ?? "").match(NUMBER)?.map(Number) ?? []);
	if (ring) rings.push(ring);
}
for (const m of text.matchAll(/<path\b([^>]*)>/g))
{
	if (!DRIVE_FILL.test((m[1].match(/\bfill="([^"]*)"/) ?? [])[1] ?? "")) continue;
	const d = (m[1].match(/\bd="([^"]*)"/) ?? [])[1] ?? "";
	if (/[^MLZmlz0-9\s.,+\-eE]/.test(d)) continue;
	const ring = to_ring(d.match(NUMBER)?.map(Number) ?? []);
	if (ring) rings.push(ring);
}
const area = (r: Ring) => Math.abs(r.reduce((t, p, i) => { const q = r[(i + 1) % r.length]; return t + p.x * q.y - q.x * p.y; }, 0) / 2);
rings.sort((a, b) => area(b) - area(a));
if (rings.length === 0) { console.log(JSON.stringify({ error: "no shape in the drive colour", drive_classes: [...drive_classes] })); process.exit(1); }

const ring = rings[0].map((p) => ({ x: p.x / px_per_ft, y: p.y / px_per_ft }));
const started = performance.now();
try
{
	const out = identify(ring, { now: () => performance.now() });
	console.log(JSON.stringify({
		file, px_per_ft, drive_shapes_in_colour: rings.length, ring_points: ring.length, paving_sf: Math.round(area(ring)),
		spurs_removed: out.spurs_removed, junctions_collapsed: out.junctions_collapsed,
		runs: [...out.runs].sort((a, b) => b.length - a.length).map((r) => ({ category: r.category, length: +r.length.toFixed(1), avg_width: +r.avg_width.toFixed(1), nodes: r.node_indices.length, reason: r.reason })),
		stalls: out.stalls.map((s) => { const b = oriented_box(s.ring); return { sf: Math.round(s.area_sq_ft), short: b ? +b.short_ft.toFixed(1) : null, long: b ? +b.long_ft.toFixed(1) : null, angle: s.angle_to_aisle_deg === null ? null : Math.round(s.angle_to_aisle_deg) }; }),
		aprons: out.aprons.summary,
		regions: out.regions.map((g) => ({ category: g.category, sf: Math.round(g.lanes.reduce((t, l) => t + l.getArea(), 0)) })),
		measurements: out.measurements.map((m) => `${m.category} ${m.dimension} ${m.value_ft.toFixed(1)}`),
		elapsed_ms: Math.round(performance.now() - started),
	}, null, 1));
}
catch (e)
{
	console.log(JSON.stringify({ file, px_per_ft, ring_points: ring.length, error: String((e as Error)?.message ?? e).slice(0, 300), stack: String((e as Error)?.stack ?? "").split("\n").slice(1, 6).map((l) => l.trim()) }, null, 1));
	process.exit(1);
}
