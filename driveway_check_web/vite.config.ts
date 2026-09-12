import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
	// The real plans live one level up in reference/test SVG, and the headless
	// corpus run fetches them straight from there via /@fs/ rather than copying
	// 350 MB into public/. Vite serves nothing above the app root unless told to.
	server: { fs: { allow: [".."] } },
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
});
