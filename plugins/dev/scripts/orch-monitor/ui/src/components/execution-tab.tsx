// execution-tab.tsx — the Execution tab panel for the ticket detail page.
// CTL-1102. A record of what happened: NOW card, narrative, Gantt with idle
// gaps, artifacts table, exceptions & decisions, hop log.
// Best-effort: every section guards its own data independently.
import { useEffect, useState } from "react";
import { C, CARD_LIFT } from "../board/board-tokens";
import { Radio } from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { buildBars } from "./ticket-gantt";
import { phaseColor, fmtDuration, fmtClock, phaseModelLabel, fmtCost } from "@/lib/formatters";
import {
  buildNowCard,
  buildNarrativeSummary,
  buildIdleGaps,
  buildExceptionsList,
  buildArtifactsRows,
  type ExceptionKind,
} from "@/board/execution-tab-model";
import type { Journey, JourneyHop } from "@/lib/journey-model";
import { isJourney } from "@/lib/journey-model";
import type { BoardTicket, BoardPhaseCost } from "@/board/types";
import { linearDeepLink } from "@/board/ticket-page-model";

// ── useJourney fetch hook ─────────────────────────────────────────────────────

/** Best-effort fetch of /api/journey/:ticket. Returns null while loading or on
 *  any error — never blocks render (resilience learning:
 *  audit-proxy-must-not-be-load-bearing). */
function useJourney(ticketId: string): Journey | null {
  const [journey, setJourney] = useState<Journey | null>(null);
  useEffect(() => {
    if (!ticketId) return;
    let stop = false;
    fetch(`/api/journey/${encodeURIComponent(ticketId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((body) => {
        if (!stop && isJourney(body)) setJourney(body);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [ticketId]);
  return journey;
}

// ── internal UI helpers ───────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        font: `10px ${C.mono}`,
        letterSpacing: 1,
        color: C.fgMuted,
        textTransform: "uppercase",
        margin: "0 0 8px",
      }}
    >
      {children}
    </div>
  );
}

function NeedsPlumbing({ label }: { label: string }) {
  return (
    <span
      data-needs-plumbing={label}
      title={`${label} — NEEDS-PLUMBING`}
      style={{ color: C.fgDim, font: `10px ${C.mono}` }}
    >
      ↯ {label}
    </span>
  );
}

const EXCEPTION_KIND_COLOR: Record<ExceptionKind, string> = {
  failure: C.red,
  held: C.yellow,
  "operator-note": C.blue,
  "auto-unstuck": C.green,
  "remediate-cycles": C.orange,
  "verify-failure": C.red,
  "decision-ahead": C.fgMuted,
};

// ── ExecutionTab ──────────────────────────────────────────────────────────────

interface ExecutionTabProps {
  ticket: BoardTicket | undefined;
  id: string;
  artifacts: Array<{ kind: string; path: string; peek: string | null }>;
}

export function ExecutionTab({ ticket, id, artifacts }: ExecutionTabProps) {
  const journey = useJourney(ticket?.id ?? id);

  // Off-board: no resident ticket — render what we can from the journey.
  if (!ticket) {
    return (
      <div data-ticket-execution style={{ paddingTop: 16 }}>
        <EmptyState
          icon={Radio}
          message="No resident telemetry — this ticket is not in the live board payload"
        />
        {/* Narrative still renders if journey loaded off-board */}
        {journey && (
          <div style={{ marginTop: 16 }}>
            <SectionLabel>Summary</SectionLabel>
            <p style={{ font: `13px ${C.mono}`, color: C.fg, margin: 0, lineHeight: 1.6 }}>
              {buildNarrativeSummary(journey)}
            </p>
          </div>
        )}
      </div>
    );
  }

  const nowCard = buildNowCard(ticket, journey);
  const narrative = buildNarrativeSummary(journey);
  const idleGaps = buildIdleGaps(ticket.phaseSummary);
  const exceptions = buildExceptionsList(journey, ticket);
  const artifactRows = buildArtifactsRows(artifacts, ticket, journey);
  const bars = buildBars(ticket.phaseSummary, Date.now());

  return (
    <div data-ticket-execution style={{ paddingTop: 16, display: "flex", flexDirection: "column", gap: 24 }}>

      {/* 1. NOW card */}
      {nowCard && (
        <section data-execution-now>
          <SectionLabel>Now</SectionLabel>
          <div
            style={{
              background: C.s2,
              border: `1px solid ${C.borderSubtle}`,
              boxShadow: CARD_LIFT,
              borderRadius: 6,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: phaseColor(nowCard.phaseLabel),
                flexShrink: 0,
                display: "inline-block",
              }}
            />
            <span style={{ font: `13px ${C.mono}`, color: C.fg }}>
              {nowCard.phaseLabel}
            </span>
            <span style={{ font: `11px ${C.mono}`, color: C.fgMuted }}>
              {nowCard.status}
            </span>
            {nowCard.nextLabel && (
              <span style={{ font: `11px ${C.mono}`, color: C.fgDim, marginLeft: "auto" }}>
                next: {nowCard.nextLabel}
              </span>
            )}
            {nowCard.attention && (
              <span
                style={{
                  font: `10px ${C.mono}`,
                  color: nowCard.attention === "needs-human" ? C.red : C.yellow,
                  marginLeft: nowCard.nextLabel ? 8 : "auto",
                }}
              >
                {nowCard.attention}
              </span>
            )}
          </div>
        </section>
      )}

      {/* 2. Summary narrative */}
      <section data-execution-narrative>
        <SectionLabel>Summary</SectionLabel>
        {journey ? (
          <p style={{ font: `13px ${C.mono}`, color: C.fg, margin: 0, lineHeight: 1.6 }}>
            {narrative}
          </p>
        ) : (
          <NeedsPlumbing label="journey not loaded" />
        )}
      </section>

      {/* 3. Process-map link — NEEDS-PLUMBING: no /process route found in ui/src */}
      <section data-execution-process-map>
        <SectionLabel>Process map</SectionLabel>
        <NeedsPlumbing label="process route not yet wired" />
      </section>

      {/* 4. Gantt with timings + idle-gap markers */}
      {bars && bars.length > 0 && (
        <section data-execution-gantt>
          <SectionLabel>Timeline</SectionLabel>
          <GanttWithIdleGaps
            bars={bars}
            idleGaps={idleGaps}
            phaseCosts={ticket.phaseCosts}
          />
        </section>
      )}

      {/* 5. Artifacts table */}
      {artifactRows.length > 0 && (
        <section data-execution-artifacts>
          <SectionLabel>Artifacts</SectionLabel>
          <ArtifactsTable rows={artifactRows} ticket={ticket} />
        </section>
      )}

      {/* 6. Exceptions & Decisions */}
      {exceptions.length > 0 && (
        <section data-execution-exceptions>
          <SectionLabel>Exceptions &amp; Decisions</SectionLabel>
          <ExceptionsList rows={exceptions} />
        </section>
      )}

      {/* 7. Hop log */}
      {journey && journey.hops.length > 0 && (
        <section data-execution-hops>
          <SectionLabel>Hop log</SectionLabel>
          <HopLog hops={journey.hops} />
        </section>
      )}
    </div>
  );
}

// ── GanttWithIdleGaps ─────────────────────────────────────────────────────────

type PhaseBar = ReturnType<typeof buildBars> extends (infer T)[] | null ? T : never;

function GanttWithIdleGaps({
  bars,
  idleGaps,
  phaseCosts,
}: {
  bars: PhaseBar[];
  idleGaps: ReturnType<typeof buildIdleGaps>;
  phaseCosts: Record<string, BoardPhaseCost> | null;
}) {
  const idleByAfter = new Map(idleGaps.map((g) => [g.afterPhase, g]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {bars.map((bar) => {
        const cost = phaseCosts?.[bar.row.phase];
        const gap = idleByAfter.get(bar.row.phase);
        return (
          <div key={bar.row.phase}>
            {/* Phase bar row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "80px 1fr auto",
                alignItems: "center",
                gap: 8,
                padding: "2px 0",
              }}
            >
              <span style={{ font: `11px ${C.mono}`, color: C.fgMuted, textAlign: "right" }}>
                {bar.row.phase}
              </span>
              <div
                style={{
                  position: "relative",
                  height: 10,
                  background: C.s2,
                  borderRadius: 3,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: `${bar.leftPct}%`,
                    width: `${Math.max(bar.widthPct, 0.5)}%`,
                    height: "100%",
                    background: phaseColor(bar.row.phase),
                    borderRadius: 3,
                    opacity: bar.isRunning ? 0.7 : 1,
                  }}
                />
              </div>
              <span style={{ font: `10px ${C.mono}`, color: C.fgDim, whiteSpace: "nowrap" }}>
                {bar.durationLabel}
                {bar.row.model && (
                  <span style={{ marginLeft: 4 }}>{phaseModelLabel(bar.row.model)}</span>
                )}
                {cost && (
                  <span style={{ marginLeft: 4, color: C.fgMuted }}>{fmtCost(cost.costUSD)}</span>
                )}
              </span>
            </div>

            {/* Idle gap marker between phases */}
            {gap && gap.ms > 1_000 && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 1fr auto",
                  alignItems: "center",
                  gap: 8,
                  padding: "1px 0",
                  opacity: 0.5,
                }}
              >
                <span />
                <div
                  style={{
                    borderTop: `1px dashed ${C.borderSubtle}`,
                  }}
                />
                <span style={{ font: `9px ${C.mono}`, color: C.fgDim }}>
                  idle {fmtDuration(gap.ms)}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── ArtifactsTable ────────────────────────────────────────────────────────────

function ArtifactsTable({
  rows,
  ticket,
}: {
  rows: ReturnType<typeof buildArtifactsRows>;
  ticket: BoardTicket;
}) {
  const prLink = ticket.pr != null ? linearDeepLink(ticket.id) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((row, i) => (
        <div
          key={`${row.phase}-${i}`}
          style={{
            display: "grid",
            gridTemplateColumns: "80px 1fr",
            gap: 8,
            alignItems: "start",
            font: `12px ${C.mono}`,
            color: C.fg,
          }}
        >
          <span style={{ color: C.fgMuted }}>{row.phase}</span>
          <span>
            {row.research && (
              <span style={{ display: "block", color: C.fgMuted }} title={row.research.peek ?? undefined}>
                research: {row.research.path.split("/").pop()}
              </span>
            )}
            {row.plan && (
              <span style={{ display: "block", color: C.fgMuted }} title={row.plan.peek ?? undefined}>
                plan: {row.plan.path.split("/").pop()}
              </span>
            )}
            {row.pr != null && (
              <span style={{ display: "block" }}>
                PR #{row.pr}
                {prLink && (
                  <a
                    href={prLink}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginLeft: 6, color: C.blue }}
                  >
                    ↗
                  </a>
                )}
              </span>
            )}
            {row.verifyVerdict != null && (
              <span
                style={{
                  display: "block",
                  color: row.verifyVerdict === "pass" ? C.green : C.red,
                }}
              >
                verify: {row.verifyVerdict}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── ExceptionsList ────────────────────────────────────────────────────────────

function ExceptionsList({ rows }: { rows: ReturnType<typeof buildExceptionsList> }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 8,
            alignItems: "center",
            font: `12px ${C.mono}`,
          }}
        >
          <span
            style={{
              font: `9px ${C.mono}`,
              letterSpacing: 0.5,
              color: EXCEPTION_KIND_COLOR[row.kind],
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            {row.kind}
          </span>
          <span style={{ color: C.fg }}>
            {row.phase && (
              <span style={{ color: C.fgMuted, marginRight: 6 }}>{row.phase}</span>
            )}
            {row.detail}
          </span>
          {row.ts && (
            <span style={{ font: `10px ${C.mono}`, color: C.fgDim, whiteSpace: "nowrap" }}>
              {fmtClock(new Date(row.ts))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── HopLog ───────────────────────────────────────────────────────────────────

function HopLog({ hops }: { hops: JourneyHop[] }) {
  const sorted = [...hops].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {sorted.map((hop, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "80px 100px 1fr",
            gap: 8,
            font: `11px ${C.mono}`,
            color: C.fgMuted,
            alignItems: "center",
          }}
        >
          <span style={{ color: C.fgDim }}>
            {fmtClock(new Date(hop.ts))}
          </span>
          <span style={{ color: phaseColor(hop.phase) }}>{hop.phase}</span>
          <span style={{ color: C.fg }}>
            {hop.eventType}
            {hop.reason && (
              <span style={{ marginLeft: 6, color: C.fgDim }}>— {hop.reason}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
