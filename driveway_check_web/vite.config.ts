import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Plugin } from "vite";

/** Dev-only: lets the headless corpus run POST its results straight to
 * reference/census/ instead of hauling 100 KB of CSV out through the browser
 * tooling. Accepts {name, text}; the name is reduced to a bare file name, so
 * nothing can be written anywhere else. Not part of the built app. */
function census_sink(): Plugin
{
	const dir = resolve(fileURLToPath(new URL("../reference/census", import.meta.url)));
	return {
		name: "census-sink",
		configureServer(server)
		{
			server.middlewares.use("/__census/save", (req, res) =>
			{
				if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
				let body = "";
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () =>
				{
					try
					{
						const { name, text } = JSON.parse(body) as { name: string; text: string };
						const file = resolve(dir, basename(String(name)));
						mkdirSync(dir, { recursive: true });
						writeFileSync(file, String(text));
						res.setHeader("content-type", "application/json");
						res.end(JSON.stringify({ saved: file, bytes: Buffer.byteLength(String(text)) }));
					}
					catch (e) { res.statusCode = 400; res.end(String(e)); }
				});
			});
		},
	};
}

export default defineConfig({
	// The real plans live one level up in reference/test SVG, and the headless
	// corpus run fetches them straight from there via /@fs/ rather than copying
	// 350 MB into public/. Vite serves nothing above the app root unless told to.
	server: { fs: { allow: [".."] } },
	plugins: [react(), tailwindcss(), census_sink()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
});
