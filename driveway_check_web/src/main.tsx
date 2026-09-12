import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { identify } from "@/lib/identify";

// Dev-only probe so the console can run the pipeline directly (A/B a stage on
// and off against a real plan). Stripped from production builds.
if (import.meta.env.DEV)
{
	(window as unknown as Record<string, unknown>).__identify = identify;
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>
);
