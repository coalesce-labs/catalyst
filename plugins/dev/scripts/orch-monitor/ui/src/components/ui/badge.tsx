import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";
import {
  statusSemantic,
  SEMANTIC_BADGE_CLASSES,
  SEMANTIC_PILL_CLASSES,
} from "@/lib/formatters";

// ── domain status components (used across the dashboard: dashboard, worker-table,
// worker/session drawers, wave-cards) — driven by statusSemantic() ─────────────
export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const sem = statusSemantic(status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        SEMANTIC_BADGE_CLASSES[sem],
        className,
      )}
    >
      {status}
    </span>
  );
}

export function StatusPill({
  label,
  status,
  className,
}: {
  label: string;
  status: string;
  className?: string;
}) {
  const sem = statusSemantic(status);
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px font-mono text-[11px]",
        SEMANTIC_PILL_CLASSES[sem],
        className,
      )}
    >
      {label}
    </span>
  );
}

// ── generic shadcn Badge (added for the CTL-727 board's chips) ──────────────
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
