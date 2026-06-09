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
import { useEffect, useMemo, useState } from "react";

import {
  calmHeaderSentence,
  deriveInbox,
  moveSelection,
  rowById,
} from "@/board/home-inbox";
import { isTypingTarget } from "@/lib/surface";
import { useBoardSnapshot } from "@/hooks/use-board-snapshot";
import { ResizableSplit } from "./resizable-split";
import { InboxRow } from "./inbox-row";
import { ReadingPane } from "./reading-pane";

/** The left list: the calm header sentence + the grouped bare-row sections. */
function InboxList({
  header,
  sections,
  selectedId,
  onSelect,
  status,
}: {
  header: string;
  sections: ReturnType<typeof deriveInbox>["sections"];
  selectedId: string | null;
  onSelect: (id: string) => void;
  status: string;
}) {
  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* The calm "state of things" header — ONE sentence, never a KPI grid. */}
      <header className="shrink-0 border-b border-border px-4 py-4">
        <p className="text-[13px] text-fg" data-calm-header>
          {header}
        </p>
        {status !== "connected" && (
          <p className="mt-1 text-[11px] text-muted">connecting to the read-model…</p>
        )}
      </header>

      {/* Flat bare-row list — sections are hairline-divided groups, NOT cards. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12px] text-muted">
            All clear — nothing needs you right now.
          </p>
        ) : (
          sections.map((section) => (
            <section key={section.kind} className="border-b border-border last:border-b-0">
              <h2 className="px-4 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                {section.label}
                <span className="ml-2 font-mono text-muted/70">{section.rows.length}</span>
              </h2>
              {/* Rows are divided by a hairline divider between them (the list is
                  the container; each row is bare). */}
              <div className="divide-y divide-border-subtle">
                {section.rows.map((row) => (
                  <InboxRow
                    key={row.id}
                    row={row}
                    selected={row.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export function HomeSurface() {
  const { payload, status } = useBoardSnapshot();

  // Derive the whole inbox from the resident snapshot (PURE). When no payload has
  // landed yet, an empty payload yields an empty (but valid) model.
  const model = useMemo(
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

  // The selection: null until the operator (or the default-select effect) picks a
  // row. Held in React state so j/k and click both drive the one reading pane.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Default-select the top item on load, and keep the selection valid as the
  // snapshot reshuffles: if nothing is selected (first paint) OR the current
  // selection vanished from the order, fall back to the head of the walk order.
  useEffect(() => {
    setSelectedId((prev) => {
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

  const header = calmHeaderSentence(model.counts);
  const selectedRow = rowById(model, selectedId);

  return (
    <div className="h-full min-h-0 w-full min-w-0 bg-surface-0 text-fg">
      <ResizableSplit
        list={
          <InboxList
            header={header}
            sections={model.sections}
            selectedId={selectedId}
            onSelect={setSelectedId}
            status={status}
          />
        }
        reading={<ReadingPane row={selectedRow} />}
      />
    </div>
  );
}
