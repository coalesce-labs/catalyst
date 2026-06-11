// ticket-badge.tsx — the CTL-996 BADGE DESIGN SYSTEM. ONE CVA pill family for the
// ticket reading surface (and future surfaces): a kind → { lucide icon, color }
// table, rendered as a rounded-full pill whose colour is driven by a SINGLE
// `--badge-color` CSS custom property (one mechanism, not 12 colour classes):
//
//   text   = var(--badge-color)
//   bg     = color-mix(in srgb, var(--badge-color) 12%, transparent)
//   border = color-mix(in srgb, var(--badge-color) 28%, transparent)
//
// Restrained-colour discipline (Linear-calm): the contrast comes from the type
// weight + the single tinted pill, never a heavy filled chip. Unknown kinds fall
// back to a neutral grey pill with NO icon and NEVER throw — an unrecognised
// label is honest, not a crash.
//
// In CTL-996 the `type` kinds (bug/feature/refactor/docs/chore/test) ship in the
// status strip; the model:* and cost:* kinds exist for future surfaces but only
// the type badge must render somewhere now.

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  Bug,
  Sparkles,
  Recycle,
  BookOpen,
  Wrench,
  FlaskConical,
  Cpu,
  CircleDollarSign,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── the badge palette (the §B7 table) ────────────────────────────────────────
// cost-tier colours use the inline `C` page palette hexes (green/yellow/red) so
// the pill matches the reading surface tokens without a global CSS var.
const NEUTRAL = "#8d8d8d";

interface BadgeSpec {
  icon: LucideIcon | null;
  color: string;
}

const BADGE_SPECS: Record<string, BadgeSpec> = {
  // type kinds
  bug: { icon: Bug, color: "#e5484d" },
  feature: { icon: Sparkles, color: "#8b5cf6" },
  refactor: { icon: Recycle, color: "#14b8a6" },
  docs: { icon: BookOpen, color: "#3b82f6" },
  chore: { icon: Wrench, color: NEUTRAL },
  test: { icon: FlaskConical, color: "#22c55e" },
  // model kinds
  "model:opus": { icon: Cpu, color: "#a855f7" },
  "model:sonnet": { icon: Cpu, color: "#3b82f6" },
  "model:haiku": { icon: Cpu, color: "#10b981" },
  // cost-tier kinds (C.green / C.yellow / C.red from the page palette)
  "cost:low": { icon: CircleDollarSign, color: "#39d07a" },
  "cost:med": { icon: CircleDollarSign, color: "#eab308" },
  "cost:high": { icon: CircleDollarSign, color: "#ef5d5d" },
};

/** Resolve a kind to its { icon, color } spec. An unknown kind → neutral grey,
 *  no icon. Pure + total: never throws. Exported as the unit seam so the
 *  kind→color/icon table is testable without a DOM. */
export function badgeSpecForKind(kind: string): BadgeSpec {
  return BADGE_SPECS[kind] ?? { icon: null, color: NEUTRAL };
}

const ticketBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-px font-medium leading-[18px] whitespace-nowrap",
  {
    variants: {
      size: {
        sm: "text-[11px]",
        md: "text-xs",
      },
    },
    defaultVariants: {
      size: "sm",
    },
  },
);

export interface TicketBadgeProps
  extends Omit<React.ComponentProps<"span">, "color">,
    VariantProps<typeof ticketBadgeVariants> {
  /** A palette kind (e.g. "feature", "model:opus", "cost:high"). Unknown →
   *  neutral grey, no icon, never throws. */
  kind: string;
  /** Optional display text; defaults to the kind itself. */
  label?: string;
}

/** TicketBadge — a colour-tinted lucide pill driven by one `--badge-color` prop. */
export function TicketBadge({
  kind,
  label,
  size = "sm",
  className,
  style,
  ...props
}: TicketBadgeProps) {
  const { icon: Icon, color } = badgeSpecForKind(kind);
  return (
    <span
      data-ticket-badge={kind}
      className={cn(ticketBadgeVariants({ size }), className)}
      style={{
        // ONE mechanism: the colour flows from a single custom property.
        ["--badge-color" as string]: color,
        color: "var(--badge-color)",
        background: "color-mix(in srgb, var(--badge-color) 12%, transparent)",
        borderColor: "color-mix(in srgb, var(--badge-color) 28%, transparent)",
        ...style,
      }}
      {...props}
    >
      {Icon && <Icon size={12} aria-hidden />}
      {label ?? kind}
    </span>
  );
}
