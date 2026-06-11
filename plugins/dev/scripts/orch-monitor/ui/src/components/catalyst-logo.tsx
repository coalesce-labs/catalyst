import { cn } from "@/lib/utils";

// catalyst-logo.tsx — the Catalyst chevron brand mark (CTL-893 / SHELL3).
//
// Ported from the prototype `mockups/home-proto/src/components/CatalystLogo.tsx`
// and kept byte-faithful to `assets/brand-v2/mark.svg`: an inline SVG (NOT an
// <img>) so the chevron `stroke="currentColor"` inherits the surrounding text
// color and recolors for free across the calm-dark / warm-light themes — an
// <img src=…svg> can't pick up `currentColor`. The wordmark lives next to it in
// the SidebarHeader and is what hides on icon-collapse; this mark stays.

/** The double-chevron Catalyst mark. Inherits `currentColor` → themes. */
export function CatalystLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      role="img"
      aria-label="Catalyst"
      className={cn("shrink-0", className)}
    >
      <title>Catalyst</title>
      <path d="M 8 44 L 32 20 L 56 44" />
      <path d="M 18 52 L 32 36 L 46 52" strokeWidth={4} opacity={0.75} />
    </svg>
  );
}
