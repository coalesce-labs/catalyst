// ticket-phase-stepper.tsx — the EDUCATIONAL phase stepper for the Lifecycle tab
// (CTL-996 §B4). A vertical list of the 10 canonical PIPELINE_PHASES — per row a
// phase dot (phaseColor), the phase label, the resident status (muted "not run"
// when the ticket never reached that phase), and a one-line muted description of
// what the phase DOES. It teaches the operator what the pipeline is; the live
// LifecycleTimeline + Gantt below it show where THIS ticket sits.
//
// Status comes from resolvePipelineRail (the SAME phaseSummary-sourced model the
// rest of the page uses — no new derivation). The current phase gets the cyan
// "here now" dot (resolvePipelineRail's `current` placement); cyan stays reserved.

import { useMemo } from "react";
import { C, LIVE } from "../board/board-tokens";
import {
  resolvePipelineRail,
  PIPELINE_PHASES,
} from "@/board/ticket-page-model";
import { phaseColor } from "@/lib/formatters";
import type { BoardTicket } from "@/board/types";


/** One-line description per canonical phase (verbatim copy, §B4). */
const PHASE_DESCRIPTION: Record<string, string> = {
  triage: "Classify the ticket, find blockers, estimate scope",
  research: "Map the relevant code and prior art",
  plan: "Write the TDD implementation plan",
  implement: "Red→green→refactor commits on a worktree branch",
  verify: "Adversarial read-only check of the diff",
  review: "Full code review + remediation commit",
  pr: "Open the pull request",
  "monitor-merge": "Watch CI, fix-ups, rebase, squash-merge",
  "monitor-deploy": "Watch the post-merge deploy + canary",
  teardown: "Archive artifacts, delete the worktree",
};

/** TicketPhaseStepper — the educational 10-phase list with per-phase status +
 *  description. */
export function TicketPhaseStepper({ ticket }: { ticket: BoardTicket }) {
  const segments = useMemo(() => resolvePipelineRail(ticket), [ticket]);

  return (
    <div data-ticket-phase-stepper style={{ marginBottom: 16, maxWidth: 680 }}>
      {PIPELINE_PHASES.map((phase) => {
        const seg = segments.find((s) => s.phase === phase);
        const isCurrent = seg?.placement === "current";
        const dotColor = isCurrent ? LIVE : phaseColor(phase);
        const status = seg?.status ?? null;
        return (
          <div
            key={phase}
            data-phase-step={phase}
            data-current={isCurrent}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "5px 0",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: dotColor,
                marginTop: 5,
                flex: "0 0 auto",
                boxShadow: isCurrent ? `0 0 0 2px ${LIVE}44` : "none",
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: isCurrent ? C.fg : C.fg }}>
                  {seg?.label ?? phase}
                </span>
                <span style={{ font: `11px ${C.mono}`, color: status ? C.fgMuted : C.fgDim }}>
                  {status ?? "not run"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: C.fgMuted, lineHeight: 1.4 }}>
                {PHASE_DESCRIPTION[phase] ?? ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
