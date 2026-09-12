import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = {
	onFile: (name: string, text: string) => void;
	onError: (message: string) => void;
};

export function SvgDropzone({ onFile, onError }: Props)
{
	const [dragging, set_dragging] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	async function accept(file: File | undefined)
	{
		if (!file) return;
		if (!file.name.toLowerCase().endsWith(".svg"))
		{
			onError(`${file.name} is not an .svg file.`);
			return;
		}
		onFile(file.name, await file.text());
	}

	return (
		<div
			onDragOver={(e) => { e.preventDefault(); set_dragging(true); }}
			onDragLeave={() => set_dragging(false)}
			onDrop={(e) => { e.preventDefault(); set_dragging(false); accept(e.dataTransfer.files[0]); }}
			className={cn(
				"flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-16 transition-colors",
				dragging ? "border-landing bg-landing/5" : "border-border bg-card"
			)}
		>
			<Upload className="size-6 text-muted-foreground" strokeWidth={1.5} />
			<div className="text-center">
				<p className="text-sm font-medium">Drop a site plan SVG here</p>
				<p className="mt-1 text-xs text-muted-foreground">
					Read in the browser. Nothing is uploaded to a server.
				</p>
			</div>
			<Button onClick={() => input.current?.click()}>Choose file</Button>
			<input
				ref={input}
				type="file"
				accept=".svg,image/svg+xml"
				className="hidden"
				onChange={(e) => accept(e.target.files?.[0])}
			/>
		</div>
	);
}
