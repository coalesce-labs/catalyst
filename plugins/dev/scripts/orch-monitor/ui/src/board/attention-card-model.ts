// attention-card-model.ts — CTL-1126. Pure, React-free model for the shared
// AttentionCard component. No lucide/jsx imports — surface-agnostic so the
// board view and HUD can adopt it later without changes here.
import type { InboxSectionKind, InboxRow } from "./home-inbox";
import { rowDurationMs } from "./home-inbox";
import type { PaneAccent, EscalationExplanationView } from "./reading-pane-model";
import { escalationExplanationFor } from "./reading-pane-model";
import { verbActionFor } from "./respond-client";

/** The modality of an attention card — drives glyph selection and hero fork. */
export type Modality = "action" | "waiting" | "awareness" | "informational";

/** The escalation sub-type for an action card (absent on non-action modalities). */
export type EscalationType = "decision" | "authorization" | "manual";

/**
 * Map an inbox section kind to its card modality.
 * - attention | blocked → action (operator must act)
 * - waiting → waiting (operator must answer)
 * - awareness → awareness (service outage, no action)
 * - running | done → informational (no alarm)
 */
export function modalityFor(section: InboxSectionKind): Modality {
  if (section === "attention" || section === "blocked") return "action";
  if (section === "waiting") return "waiting";
  if (section === "awareness") return "awareness";
  return "informational";
}

/**
 * The escalation sub-type for an action row, or undefined when not applicable.
 * Reads from `explanation.escalation_type`, defaulting to "decision" when the
 * explanation exists but omits the field. Returns undefined when:
 *  - the row is not in the attention section (no escalation concept), OR
 *  - the ticket carries no explanation.
 */
export function escalationTypeFor(row: InboxRow): EscalationType | undefined {
  if (row.section !== "attention") return undefined;
  const expl = row.ticket.explanation as
    | { escalation_type?: string | null }
    | null
    | undefined;
  if (expl == null) return undefined;
  const raw = expl.escalation_type;
  if (raw === "authorization") return "authorization";
  if (raw === "manual") return "manual";
  return "decision";
}

/**
 * The card accent for emphasis. Encodes two rules from the ticket:
 * - manual outranks amber → red
 * - decision / authorization → amber
 * - waiting → amber
 * - awareness / informational → none
 */
export function cardAccentFor(args: {
  modality: Modality;
  escalationType: EscalationType | undefined;
}): PaneAccent {
  const { modality, escalationType } = args;
  if (modality === "action") {
    if (escalationType === "manual") return "red";
    if (escalationType === "decision" || escalationType === "authorization") return "amber";
    return "none";
  }
  if (modality === "waiting") return "amber";
  return "none";
}

/** The complete view-model the AttentionCard reads. */
export interface AttentionCardView {
  modality: Modality;
  escalationType: EscalationType | undefined;
  accent: PaneAccent;
  verb: ReturnType<typeof verbActionFor>;
  durationMs: number | null;
  escalation: EscalationExplanationView | null;
}

/**
 * Assemble the full AttentionCard view-model for a row.
 * Pure — `now` is injected so the model stays trivially testable.
 */
export function attentionCardModel(row: InboxRow, now: number): AttentionCardView {
  const modality = modalityFor(row.section);
  const escalationType = escalationTypeFor(row);
  return {
    modality,
    escalationType,
    accent: cardAccentFor({ modality, escalationType }),
    verb: verbActionFor(row),
    durationMs: rowDurationMs(row, now),
    escalation: escalationExplanationFor(row),
  };
}
