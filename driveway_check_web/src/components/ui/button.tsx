import * as React from "react";
import { cn } from "@/lib/utils";

/** Trimmed from cedar-build's Button — same tokens, only the variants this tool uses. */
const variants = {
	default:
		"bg-landing text-landing-foreground border border-foreground/15 shadow-glow hover:bg-landing/90",
	outline:
		"text-foreground/90 border border-border bg-background/90 hover:bg-accent hover:text-accent-foreground",
	ghost: "hover:bg-accent hover:text-accent-foreground",
} as const;

const sizes = {
	sm: "h-6 px-3 text-xs [&_svg]:size-3",
	base: "h-8 px-4 text-sm [&_svg]:size-3.5",
} as const;

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: keyof typeof variants;
	size?: keyof typeof sizes;
};

export function Button({ className, variant = "default", size = "base", ...props }: ButtonProps)
{
	return (
		<button
			className={cn(
				"inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium outline-none transition-colors",
				"focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				"disabled:pointer-events-none disabled:opacity-50",
				variants[variant],
				sizes[size],
				className
			)}
			{...props}
		/>
	);
}
