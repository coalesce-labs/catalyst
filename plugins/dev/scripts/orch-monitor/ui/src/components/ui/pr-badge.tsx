import { cn } from "@/lib/utils";
import {
  derivePrVariant,
  prBadgeTheme,
  type PrBadgeVariant,
} from "../../../../lib/pr-variant";

export interface PrBadgeProps {
  number: number | null | undefined;
  url?: string | null;
  state?: string | null;
  mergeStateStatus?: string | null;
  isDraft?: boolean | null;
  mergedAt?: string | null;
  title?: string | null;
  className?: string;
  /** When true, omit the trailing variant label (tight columns). */
  compact?: boolean;
}

function tooltipFor(
  variant: PrBadgeVariant,
  number: number,
  opts: { title?: string | null; mergedAt?: string | null },
): string {
  const lines: string[] = [];
  const titleLine = opts.title ? `${opts.title} ` : "";
  switch (variant) {
    case "merged": {
      const when = opts.mergedAt
        ? new Date(opts.mergedAt).toLocaleString()
        : null;
      lines.push(
        `#${number} — merged${when ? ` on ${when}` : ""}`,
      );
      break;
    }
    case "draft":
      lines.push(`#${number} — draft (not ready for review)`);
      break;
    case "blocked":
      lines.push(`#${number} — blocked (failing required check or review)`);
      break;
    case "conflict":
      lines.push(`#${number} — merge conflicts`);
      break;
    case "unstable":
      lines.push(`#${number} — checks failing`);
      break;
    case "closed":
      lines.push(`#${number} — closed without merge`);
      break;
    case "open":
      lines.push(`#${number} — open`);
      break;
    default:
      lines.push(`#${number}`);
  }
  if (opts.title && variant !== "merged") lines.push(opts.title);
  return [titleLine, ...lines].filter(Boolean).join("\n").trim() || `#${number}`;
}

export function PrBadge({
  number,
  url,
  state,
  mergeStateStatus,
  isDraft,
  mergedAt,
  title,
  className,
  compact,
}: PrBadgeProps) {
  if (!number) {
    return <span className="text-muted">—</span>;
  }

  const variant = derivePrVariant({ state, mergeStateStatus, isDraft });
  const theme = prBadgeTheme(variant);

  const showSuffix =
    !compact && (variant === "merged" || variant === "blocked" || variant === "draft" || variant === "closed");

  const content = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap transition-colors",
        theme.pill,
        className,
      )}
      title={tooltipFor(variant, number, { title, mergedAt })}
    >
      <span className="font-mono">#{number}</span>
      {showSuffix && <span className="font-normal opacity-80">{theme.label}</span>}
    </span>
  );

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex hover:brightness-125"
      >
        {content}
      </a>
    );
  }
  return content;
}
