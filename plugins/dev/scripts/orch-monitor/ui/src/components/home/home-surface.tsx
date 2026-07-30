// home-surface.tsx — the calm master-detail Inbox HOME surface (CTL-899 / HOME1).
// The structural keystone of the HOME stream: it stands up the surface, the
// resizable split, the list/pane wiring, j/k selection, and the calm
// state-of-things header sentence — fed by the cache-backed read-model snapshot
// (SSE) rather than any synchronous Linear call.
//
// Composition:
//   useBoardSnapshot()  → the resident read-model BoardPayload (SSE, no Linear).
//   deriveInbox()       → grouped bare-row sections + the flat j/k walk order +
//                         the default selection + the calm header counts (PURE).
//   ResizableSplit      → the master-detail two-pane split with FIRM iPad floors.
//   InboxRow / ReadingPane → the bare list rows + the (HOME4-stubbed) pane.
//
// The four CTL-899 Gherkin scenarios all land here: a flat bare-row list (no
// nested cards) on the left driving a reading pane on the right in a resizable
// split; clicking a row OR pressing j/k moves the selection and updates the pane,
// with the top item selected by default; the split survives iPad-landscape via
// the ResizableSplit floors; and the data is the read-model snapshot, never a
// per-load Linear fetch.
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ALL_CLEAR_HEADLINE,
  allClearReassurance,
  calmHeaderSentence,
  deriveInbox,
  isAllClear,
  isNeedsYouSection,
  moveSelection,
  rowById,
  shippedWhileAwaySummary,
  type InboxCounts,
  type InboxSection,
} from "@/board/home-inbox";
import { isTypingTarget } from "@/lib/surface";
// CTL-897 / SHELL7: the Inbox consumes the workspace-SCOPED snapshot so the
// switcher's repo selection actually filters the inbox (All = the unfiltered
// view). The scoped hook wraps the SAME shared board transport (one EventSource).
import { useScopedBoardSnapshot } from "@/hooks/use-scoped-board-snapshot";
// CTL-903 / HOME5: the WRITE path — the one bright verb records the response +
// resumes the agent, with optimistic rollback. The hook owns the optimistic
// state + grace timer; the pure client/fetch live in board/respond-client.ts.
import { useRespond, type RespondRowStatus } from "@/hooks/use-respond";
import type { ReplyOutcome } from "@/board/conversation-client";
import { ResizableSplit } from "./resizable-split";
import { InboxRow } from "./inbox-row";
import { ReadingPane } from "./reading-pane";
import { AllClearHero } from "./all-clear-hero";

/** The all-clear LIST state (CTL-904 / HOME6): when nothing needs the operator,
 *  the list reads as everything-handled — the "All clear" headline + how many
 *  shipped while you were away + the running-on-their-own reassurance — instead of
 *  the bare alarm-count sections. The relief payoff, designed as a feature. The
 *  celebratory entrance collapses to instant under prefers-reduced-motion. */
function AllClearList({ counts }: { counts: InboxCounts }) {
  const shipped = shippedWhileAwaySummary(counts);
  return (
    <div
      data-all-clear-list
      className="animate-fade-in motion-reduce:animate-none flex flex-col items-center gap-2 px-6 py-12 text-center"
    >
      <p className="text-[14px] font-medium text-fg">{ALL_CLEAR_HEADLINE}</p>
      {shipped && <p className="text-[12px] text-muted">{shipped}</p>}
      <p className="mt-1 max-w-xs text-[12px] leading-relaxed text-muted opacity-80">
        {allClearReassurance(counts)}
      </p>
    </div>
  );
}

/** One inbox section. The needs-you sections (blocked / waiting) render their
 *  rows OPEN; the reassurance sections (running on its own / done) collapse to a
 *  quiet count by default (CTL-901 scenario 1 — "a collapsed reassurance count
 *  by default") and expand on click. */
function InboxSectionBlock({
  section,
  selectedId,
  onSelect,
  now,
}: {
  section: InboxSection;
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  // Needs-you sections are always open (you must see what needs you). The
  // reassurance sets start collapsed so the page de-alarms by subtraction.
  const collapsible = !isNeedsYouSection(section.kind);
  const [open, setOpen] = useState<boolean>(!collapsible);

  return (
    <section
      data-inbox-section={section.kind}
      data-collapsed={collapsible && !open ? "true" : undefined}
      className="border-b border-border last:border-b-0"
    >
      <h2 className="px-4 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
        {collapsible ? (
          // A collapsed reassurance section is a count chip you can expand —
          // "Running on its own  4" — not a wall of rows.
          <button
            type="button"
            data-section-toggle={section.kind}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left uppercase tracking-wide hover:text-fg"
          >
            <span aria-hidden className="font-mono text-[10px] text-muted/70">
              {open ? "▾" : "▸"}
            </span>
            {section.label}
            <span className="font-mono text-muted/70">{section.rows.length}</span>
          </button>
        ) : (
          <>
            {section.label}
            <span className="ml-2 font-mono text-muted/70">{section.rows.length}</span>
          </>
        )}
      </h2>
      {/* Rows are divided by a hairline divider between them (the list is the
          container; each row is bare). Collapsed reassurance sections render no
          rows — just the count chip above. */}
      {open && (
        <div className="divide-y divide-border-subtle">
          {section.rows.map((row) => (
            <InboxRow
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={onSelect}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The left list: the calm header sentence + the grouped bare-row sections. */
function InboxList({
  header,
  sections,
  counts,
  selectedId,
  onSelect,
  status,
  now,
}: {
  header: string;
  sections: ReturnType<typeof deriveInbox>["sections"];
  counts: InboxCounts;
  selectedId: string | null;
  onSelect: (id: string) => void;
  status: string;
  now: number;
}) {
  return (
    <div className="flex h-full flex-col bg-surface-1">
      {/* The calm "state of things" header — ONE sentence, never a KPI grid.
          In the all-clear state it reads as everything-handled (no alarm count). */}
      <header className="shrink-0 border-b border-border px-4 py-4">
        <p className="text-[13px] text-fg" data-calm-header>
          {header}
        </p>
        {status !== "connected" && (
          <p className="mt-1 text-[11px] text-muted">connecting to the read-model…</p>
        )}
      </header>

      {/* Flat bare-row list — sections are hairline-divided groups, NOT cards.
          When nothing needs the operator, the calm all-clear list replaces the
          sections entirely (the relief payoff). */}
      <div className="cat-overlay-scroll min-h-0 flex-1 overflow-y-auto">
        {isAllClear(counts) ? (
          <AllClearList counts={counts} />
        ) : (
          sections.map((section) => (
            <InboxSectionBlock
              key={section.kind}
              section={section}
              selectedId={selectedId}
              onSelect={onSelect}
              now={now}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function HomeSurface() {
  const { payload, status } = useScopedBoardSnapshot();

  // Derive the whole inbox from the resident snapshot (PURE). When no payload has
  // landed yet, an empty payload yields an empty (but valid) model.
  const rawModel = useMemo(
    () =>
      deriveInbox(
        payload ?? {
          generatedAt: "",
          config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
          repos: [],
          workers: [],
          tickets: [],
          queue: [],
        },
      ),
    [payload],
  );

  // CTL-903 / HOME5: the WRITE path. The hook owns the optimistic-resume state +
  // the grace-window rollback; the verb fires record-response + resume-agent
  // through the read-model write endpoint (board/respond-client.ts owns the
  // fetch). The single-node case is an exact pass-through (the endpoint's
  // identity fence no-op); a multi-node fence rejection arrives as `did-not-take`.
  const { respond, statusFor, reconcile, markResolved } = useRespond();

  // CTL-1569 / AC #8 ("posting removes the row without a manual refresh"): the
  // optimistic mark alone was NOT enough. `statusFor` only changed how the pane
  // rendered — `sections` and `order` still carried the row, so it stayed visible
  // AND selected with a live reply box until some later SSE frame happened to drop
  // it, which invited a duplicate submission in the gap. So the marks are PROJECTED
  // out of the model here.
  //
  // This is safe precisely because it is not permanent: `reconcile` still runs on
  // every frame, and a mark that is still waiting past the grace window rolls back
  // (`markDidNotTake`), which removes it from `resolvedIds` and returns the row.
  // Optimistic hide + the existing rollback is the whole contract.
  const resolvedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rawModel.order) {
      if (isNeedsYouSection(row.section) && statusFor(row.id) === "resuming") ids.add(row.id);
    }
    return ids;
  }, [rawModel, statusFor]);

  const model = useMemo(() => {
    if (resolvedIds.size === 0) return rawModel;
    const keep = (row: { id: string }) => !resolvedIds.has(row.id);
    const sections = rawModel.sections
      .map((sec) => ({ ...sec, rows: sec.rows.filter(keep) }))
      .filter((sec) => sec.rows.length > 0);
    const order = rawModel.order.filter(keep);

    // EVERY derived field must be recomputed from the filtered rows, not copied.
    // Copying them left `defaultSelectedId` pointing at a now-hidden row (so the
    // selection effect reselected it), and left the blocked/waiting counts — which
    // drive the calm header and `isAllClear` — still reporting the removed item as
    // needing attention until another SSE frame arrived.
    const perSection = (kind: string) =>
      sections.find((sec) => sec.kind === kind)?.rows.length ?? 0;

    return {
      ...rawModel,
      sections,
      order,
      defaultSelectedId: order.length > 0 ? order[0].id : null,
      counts: {
        ...rawModel.counts,
        attention: perSection("attention"),
        blocked: perSection("blocked"),
        waiting: perSection("waiting"),
        // The AGGREGATE must be recomputed too. `isAllClear` and
        // `calmHeaderSentence` both read `needsYou`, not the components — so
        // leaving it spread through meant resolving the LAST attention row still
        // showed "1 needs you" and withheld the all-clear surface until an SSE
        // frame arrived. That is precisely the relief moment this feature exists
        // to deliver, so it must not wait on the network.
        needsYou: perSection("attention") + perSection("blocked") + perSection("waiting"),
      },
    };
  }, [rawModel, resolvedIds]);

  // The selection: null until the operator (or the default-select effect) picks a
  // row. Held in React state so j/k and click both drive the one reading pane.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // CTL-901 (HOME3): one shared "now" clock the row durations measure against,
  // ticked every 30s so a row reading "4m" advances to "5m" without re-fetching.
  // 30s cadence keeps the calm page quiet (no per-second churn) while staying
  // honest for the coarse single-unit display.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Default-select the top item on load, and keep the selection valid as the
  // snapshot reshuffles: if nothing is selected (first paint) OR the current
  // selection vanished from the order, fall back to the head of the walk order.
  useEffect(() => {
    setSelectedId((prev) => {
      // A row that was optimistically resolved is gone from `order`, so the
      // selection falls through to the recomputed default rather than sticking to
      // an id the list no longer renders.
      if (prev != null && model.order.some((r) => r.id === prev)) return prev;
      return model.defaultSelectedId;
    });
  }, [model]);

  // j / k walk the flat order (clamped, never wraps). Ignores typing targets so
  // the keys never fire while the operator is in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j") {
        e.preventDefault();
        setSelectedId((cur) => moveSelection(model.order, cur, +1));
      } else if (e.key === "k") {
        e.preventDefault();
        setSelectedId((cur) => moveSelection(model.order, cur, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model.order]);

  const onAct = useCallback(
    (id: string) => {
      // The recorded note is empty for the one-click verb — the BFF12 endpoint
      // records the response (an empty body is a valid acknowledgement) and emits
      // the resume event regardless; the detail surface can carry a richer note.
      void respond(id, "");
    },
    [respond],
  );

  // CTL-1569: the inline REPLY's outcome. A confirmed post is a real resolution —
  // the Linear comment clears `needs-human` within seconds (CTL-1567) — so the row
  // is optimistically cleared through the SAME mark + grace-window machinery the
  // verb uses; if the label never actually clears, the standing reconcile rolls it
  // back and the row returns. Every failure marks did-not-take instead, so the item
  // is restored rather than silently lost (§4).
  const onReplied = useCallback(
    (outcome: ReplyOutcome) => {
      if (outcome.status === "replied") {
        markResolved(outcome.ticket);
        return;
      }
      // Do NOT mark an UNSENT reply as a failed resume. For `no_token`,
      // `bot_identity`, `not_found` and transport failures no comment was sent and
      // no resume was ever attempted, so `PaneVerb`'s "The agent did not resume —
      // try again" is a second, wrong diagnosis printed beside the reply box's
      // accurate one. The row is still restored (it was never hidden), and the
      // specific posting error is what the operator should act on.
      // `empty` is likewise a no-op.
    },
    [markResolved],
  );

  // Reconcile the optimistic marks against EVERY new read-model frame: a row that
  // CLEARED (left the needs-you set) means the resume took (drop the mark); a row
  // STILL waiting past the grace window means it did not take (roll back → the
  // verb returns + "it didn't take"). The still-waiting set is the model's
  // needs-you rows (blocked | waiting) — the exact "still shows the item waiting"
  // the scenario re-checks.
  const stillWaitingIds = useMemo(() => {
    // RAW model on purpose: reconcile must see the row the server still reports as
    // needs-you. Reading the projected model would make an optimistically hidden
    // row look "cleared" immediately, so it could never roll back.
    const ids = new Set<string>();
    for (const row of rawModel.order) {
      if (isNeedsYouSection(row.section)) ids.add(row.id);
    }
    return ids;
  }, [rawModel]);
  useEffect(() => {
    reconcile(stillWaitingIds);
  }, [stillWaitingIds, reconcile]);

  // CTL-904 / HOME6: the all-clear gate — nothing needs the operator. When it
  // holds, the header reads as everything-handled (not an alarm count), the list
  // shows the celebratory all-clear state, and the reading pane shows the calm
  // all-clear hero instead of a per-row detail (never a blank pane).
  const allClear = isAllClear(model.counts);
  const header = allClear ? ALL_CLEAR_HEADLINE : calmHeaderSentence(model.counts);
  const selectedRow = rowById(model, selectedId);

  return (
    <div className="h-full min-h-0 w-full min-w-0 bg-surface-1 text-fg">
      <ResizableSplit
        list={
          <InboxList
            header={header}
            sections={model.sections}
            counts={model.counts}
            selectedId={selectedId}
            onSelect={setSelectedId}
            status={status}
            now={now}
          />
        }
        reading={
          allClear ? (
            <AllClearHero counts={model.counts} />
          ) : (
            <ReadingPane
              row={selectedRow}
              workers={payload?.workers ?? []}
              onAct={onAct}
              respondStatus={selectedRow ? statusFor(selectedRow.id) : "idle"}
              onReplied={onReplied}
            />
          )
        }
      />
    </div>
  );
}
