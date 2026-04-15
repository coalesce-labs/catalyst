import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
  muted?: boolean;
  strikethrough?: boolean;
}

export function ExternalLink({
  href,
  children,
  className,
  muted,
  strikethrough,
}: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "font-mono text-[12px]",
        muted ? "text-muted" : "text-accent hover:underline",
        strikethrough && "line-through",
        className,
      )}
    >
      {children}
    </a>
  );
}
