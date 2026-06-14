// phase-outcome.tsx — the worker-detail v2 phase-aware "What it (is) doing / did"
// section (CTL-925 / WORKER-DETAIL v2 Pass B §6). A generic <PhaseOutcome> that
// switches on worker.phase and renders ONLY the panels that phase's available data
// supports, leading with workflow outcome (not systems). The phase→section mapping
// is the PURE phaseToSectionKind (phase-outcome-data.ts, unit-tested); this is the
// thin renderer.
//
// SOURCES (all EXISTING endpoints — no new plumbing):
//   • the verbatim phase signal (usePhaseSignal → Record<string,unknown>), read
//     defensively for PR shape / verdict / triage fields,
//   • the resident BoardTicket (estimate/estimateDisplay/scope/type/pr),
//   • the artifacts list (/api/ticket-artifacts/<ticket>) for research/plan peeks.
//
// HONEST DIMS (GROUND-TRUTH verified on mini 2026-06-10): the LIVE signal carries
// only the lifecycle envelope (no inline verdict/PR/classification — those live in
// verify.json / phase-pr.json / on Linear), and the mini node's local thoughts
// tree often lacks a peer node's research/plan doc (cross-node eventual
// consistency). So absent fields render "— ↯" / "(pending)" — NEVER fabricated.
// The raw SignalPanel below this (in the body) is the always-available escape hatch.

import { useEffect, useState } from "react";
import { C } from "./board-tokens";
import { Link } from "@tanstack/react-router";
import type { BoardTicket } from "./types";
import type { DetailSearch } from "./route-search";
import {
  phaseToSectionKind,
  artifactKindForPhase,
  prFromSignal,
  verdictFromSignal,
  deriveTriageOutcome,
  type PhaseSectionKind,
} from "./phase-outcome-data";


// ── artifacts (the research/plan doc preview) ────────────────────────────────
interface TicketArtifact {
  kind: "research" | "plan";
  path: string;
  peek: string | null;
}
interface ArtifactsResponse {
  ticket: string;
  artifacts: TicketArtifact[];
  crossNodeCaveat: string;
}
type ArtifactsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; artifacts: TicketArtifact[]; caveat: string }
  | { kind: "error" };

function useArtifacts(ticket: string | undefined, enabled: boolean): ArtifactsState {
  const [state, setState] = useState<ArtifactsState>({ kind: "idle" });
  useEffect(() => {
    if (!enabled || !ticket) {
      setState({ kind: "idle" });
      return;
    }
    let alive = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const res = await fetch(`/api/ticket-artifacts/${encodeURIComponent(ticket)}`);
        if (!alive) return;
        if (!res.ok) {
          setState({ kind: "error" });
          return;
        }
        const body = (await res.json()) as ArtifactsResponse;
        setState({
          kind: "loaded",
          artifacts: body.artifacts ?? [],
          caveat: body.crossNodeCaveat ?? "",
        });
      } catch {
        if (alive) setState({ kind: "error" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [ticket, enabled]);
  return state;
}

// ── presentational atoms ─────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      data-phase-outcome
      style={{
        background: C.s2,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          font: `10px ${C.mono}`,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: C.fgMuted,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: string;
}) {
  const dim = value == null || value === "";
  return (
    <div
      data-outcome-field={label}
      data-plumbed={!dim}
      style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}
    >
      <span style={{ font: `11px ${C.mono}`, color: C.fgMuted, flex: "0 0 auto" }}>{label}</span>
      <span
        style={{
          font: `11px ${C.mono}`,
          color: dim ? C.fgDim : (accent ?? C.fg),
          textAlign: "right",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {dim ? "— ↯" : value}
      </span>
    </div>
  );
}

/** The deferred git-numstat placeholder (commits/LoC) — the honest "— ↯ (git
 *  plumbing follow-up)", reused from the burn COMMITS tile copy. NEVER fabricated. */
function CommitsPlaceholder() {
  return (
    <Field
      label="commits / LoC"
      value={null}
      accent={undefined}
    />
  );
}

function PrChip({
  number,
  url,
  isDraft,
}: {
  number: number;
  url: string | null;
  isDraft: boolean;
}) {
  const label = `${isDraft ? "draft PR" : "PR"} #${number}`;
  if (!url) return <span style={{ color: C.fg }}>{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      data-outcome-pr={number}
      style={{ color: "#4ea1ff", textDecoration: "none" }}
    >
      {label} ↗
    </a>
  );
}

function ArtifactPreview({
  ticket,
  kind,
  state,
  search,
}: {
  ticket: string | undefined;
  kind: "research" | "plan";
  state: ArtifactsState;
  search: DetailSearch;
}) {
  const label = kind === "research" ? "Research doc" : "Plan doc";
  if (state.kind === "loading" || state.kind === "idle") {
    return <Field label={label} value={<span style={{ color: C.fgMuted }}>loading…</span>} />;
  }
  if (state.kind === "error") {
    return <Field label={label} value={null} />;
  }
  const match = state.artifacts.find((a) => a.kind === kind);
  if (!match) {
    // Honest cross-node degraded: the local thoughts tree has no doc of this kind
    // (a peer node authored it; eventual consistency). Link out to the ticket for
    // the prose rather than fabricate a path.
    return (
      <>
        <Field
          label={label}
          value={
            ticket ? (
              <Link
                to="/ticket/$id"
                params={{ id: ticket }}
                search={search}
                style={{ color: C.fgMuted, textDecoration: "none" }}
              >
                not synced locally · open ticket ↗
              </Link>
            ) : null
          }
        />
        <div style={{ font: `10px ${C.mono}`, color: C.fgDim }}>
          {state.caveat || "cross-node artifacts appear after a thoughts-sync push"}
        </div>
      </>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Field
        label={label}
        value={<span style={{ color: "#4ea1ff" }}>{match.path}</span>}
      />
      {match.peek && (
        <pre
          data-artifact-peek={kind}
          style={{
            margin: 0,
            maxHeight: 180,
            overflow: "auto",
            background: C.s3,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 8,
            font: `10px ${C.mono}`,
            color: C.fgMuted,
            whiteSpace: "pre-wrap",
          }}
        >
          {match.peek}
        </pre>
      )}
    </div>
  );
}

// ── the phase-keyed section ──────────────────────────────────────────────────
export function PhaseOutcome({
  phase,
  ticket,
  ticketModel,
  signal,
  search,
}: {
  phase: string | undefined;
  ticket: string | undefined;
  /** The resident BoardTicket (from the body's `tickets` list) — carries the
   *  estimate/scope/type/pr the phase section reads. undefined when not resident. */
  ticketModel: BoardTicket | undefined;
  /** The verbatim phase signal (Record<string,unknown> | null). */
  signal: Record<string, unknown> | null;
  search: DetailSearch;
}) {
  const kind = phaseToSectionKind(phase);
  const artifactKind = artifactKindForPhase(kind);
  // Only fetch artifacts for the research/plan phases that preview them.
  const artifacts = useArtifacts(ticket, artifactKind != null);

  switch (kind) {
    case "triage": {
      const t = deriveTriageOutcome(signal, ticketModel);
      return (
        <Section title="Triage · is it pointing this?">
          <Field label="classification" value={t.classification} />
          <Field
            label="estimate"
            value={
              t.estimateDisplay
                ? `${t.estimateDisplay}${t.estimateMethod ? ` · ${t.estimateMethod}` : ""}`
                : null
            }
          />
          <Field label="scope" value={t.scope} />
          <Field
            label="blockers"
            value={t.blockers.length > 0 ? t.blockers.join(", ") : null}
          />
          {ticket && (
            <div style={{ font: `10px ${C.mono}`, color: C.fgDim }}>
              triage analysis is posted to{" "}
              <Link
                to="/ticket/$id"
                params={{ id: ticket }}
                search={search}
                style={{ color: C.fgMuted }}
              >
                the ticket ↗
              </Link>
            </div>
          )}
        </Section>
      );
    }

    case "implement": {
      const pr = prFromSignal(signal);
      return (
        <Section title="Implement · code & PR">
          <Field
            label="draft PR"
            value={pr ? <PrChip number={pr.number} url={pr.url} isDraft={pr.isDraft} /> : null}
          />
          <CommitsPlaceholder />
          <div style={{ font: `10px ${C.mono}`, color: C.fgDim }}>
            commits / LoC are git-sourced — telemetry plumbing follow-up
          </div>
        </Section>
      );
    }

    case "research":
    case "plan":
      return (
        <Section title={kind === "research" ? "Research · findings" : "Plan · the plan"}>
          <ArtifactPreview
            ticket={ticket}
            kind={kind}
            state={artifacts}
            search={search}
          />
        </Section>
      );

    case "verify":
    case "review": {
      const v = verdictFromSignal(signal);
      const verdictColor = v.verdict === "fail" ? C.red : v.verdict === "pass" ? C.green : undefined;
      return (
        <Section title={kind === "verify" ? "Verify · verdict" : "Review · verdict"}>
          <Field
            label="verdict"
            value={v.verdict ?? null}
            accent={verdictColor}
          />
          <Field label="HIGH findings" value={v.highFindings} />
          {kind === "verify" && <Field label="regression risk" value={v.regressionRisk} />}
          {kind === "review" && (
            <Field
              label="remediation commit"
              value={v.remediated == null ? null : v.remediated ? "yes" : "no"}
            />
          )}
          <div style={{ font: `10px ${C.mono}`, color: C.fgDim }}>
            full verdict in the raw signal&apos;s verify/review.json artifact (below)
          </div>
        </Section>
      );
    }

    case "monitor-merge": {
      const pr = prFromSignal(signal);
      return (
        <Section title="Monitor-merge · PR → merged">
          <Field
            label="PR"
            value={pr ? <PrChip number={pr.number} url={pr.url} isDraft={pr.isDraft} /> : null}
          />
          <Field label="CI" value={pr?.ciStatus ?? null} />
          <Field label="merged at" value={pr?.mergedAt ?? null} />
          <Field label="merge SHA" value={pr?.mergeCommitSha ?? null} />
        </Section>
      );
    }

    case "monitor-deploy": {
      const pr = prFromSignal(signal);
      const deployStatus =
        typeof signal?.["deployStatus"] === "string"
          ? (signal["deployStatus"] as string)
          : typeof signal?.["canaryStatus"] === "string"
            ? (signal["canaryStatus"] as string)
            : null;
      return (
        <Section title="Monitor-deploy · post-merge">
          <Field label="merge SHA" value={pr?.mergeCommitSha ?? null} />
          <Field label="deploy / canary" value={deployStatus} />
        </Section>
      );
    }

    case "remediate": {
      const v = verdictFromSignal(signal);
      return (
        <Section title="Remediate · fixing the verdict">
          <Field label="HIGH findings addressed" value={v.highFindings} />
          <Field
            label="remediation commit"
            value={v.remediated == null ? null : v.remediated ? "yes" : "no"}
          />
          <div style={{ font: `10px ${C.mono}`, color: C.fgDim }}>
            targets the prior verify.json findings (raw signal below)
          </div>
        </Section>
      );
    }

    case "teardown":
      return (
        <Section title="Teardown · cleanup">
          <Field
            label="status"
            value={typeof signal?.["status"] === "string" ? (signal["status"] as string) : null}
          />
        </Section>
      );

    default:
      // Unknown phase — the verbatim SignalPanel (rendered by the body) IS the
      // fallback, so we render nothing here rather than a duplicate raw dump.
      return null;
  }
}

export type { PhaseSectionKind };
