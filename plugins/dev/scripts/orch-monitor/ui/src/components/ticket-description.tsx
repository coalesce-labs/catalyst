// ticket-description.tsx — the HEAVY ticket DESCRIPTION renderer: the Linear-
// style markdown reading column. This is the SOLE consumer of ticket-markdown.ts
// (marked-highlight + highlight.js), so it is lazy-loaded on the ticket route
// (ticket-detail-page.tsx wraps it in React.lazy + Suspense) to code-split the
// markdown engine out of the board entry chunk (deliverable §3). The light fetch
// hook lives in use-linear-ticket.ts so the route can share one fetch without
// pulling this module in statically.
//
// Honest empty (mirrors EmptyState honesty): while !loaded a fixed-height
// skeleton holds the space so the lifecycle below never jumps; loaded &&
// !markdown → an honest "No description in Linear." — never fabricated prose.

import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { renderTicketDescriptionHtml, isTicketRef } from "@/lib/ticket-markdown";

/** TicketDescription — the Linear-style markdown reading column. */
export function TicketDescription({
  markdown,
  loaded,
}: {
  markdown: string | null;
  loaded: boolean;
}) {
  const navigate = useNavigate();

  // Soft-navigate ticket-ref pill clicks through TanStack Router (no full reload).
  const interceptTicketLinks = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Honour modifier-clicks (open-in-new-tab) — let the browser handle them.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a.ticket-ref-pill") as HTMLAnchorElement | null;
      if (!anchor) return;
      const ref = (anchor.textContent ?? "").trim();
      if (!isTicketRef(ref)) return;
      e.preventDefault();
      void navigate({ to: "/ticket/$id", params: { id: ref } });
    },
    [navigate],
  );

  // !loaded → a fixed-height skeleton line so the lifecycle below does NOT jump.
  if (!loaded) {
    return (
      <div
        data-ticket-description-skeleton
        style={{
          height: 18,
          color: "#5b626f",
          font: "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        }}
      >
        Loading description…
      </div>
    );
  }

  // loaded && empty → honest empty (never fabricated).
  if (!markdown) {
    return (
      <div
        data-ticket-description-empty
        style={{
          color: "#8b93a1",
          font: "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        }}
      >
        No description in Linear.
      </div>
    );
  }

  return (
    <div
      data-ticket-description
      // CTL-1003 §A2: Linear-style prose. The `prose prose-invert` plugin gives
      // the measure/rhythm; the unlayered `.ticket-desc` rules (app.css) map the
      // prose-invert vars to app tokens and keep the code-chip/pre/hljs/ticket-ref
      // overrides winning. (md-content is dropped — its h1/h2 underline + 78ch
      // measure fought Linear.)
      className="ticket-desc prose prose-invert"
      onClick={interceptTicketLinks}
      dangerouslySetInnerHTML={{ __html: renderTicketDescriptionHtml(markdown) }}
    />
  );
}

export default TicketDescription;
