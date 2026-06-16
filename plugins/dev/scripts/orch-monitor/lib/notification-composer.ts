/**
 * CTL-1221: Notification Composer
 *
 * Transforms escalation payloads from the recovery pass into executive-framed
 * notifications (background, trade-off, CTA) suitable for push and briefing channels.
 *
 * Three escalation types:
 * - MANUAL: blocked_capability + instructions → "fix this + retry"
 * - AUTHORIZATION: risk + recommendation → "approve this decision?"
 * - DECISION: options[] with trade-offs → "choose between these paths"
 *
 * Each transforms into:
 * - short_text (≤140 char): for push channel (PWA, native)
 * - full_briefing: markdown, for UI modal/dashboard display
 */

export interface EscalationOption {
  label: string;
  tradeoff: string;
  risk?: string;
}

export interface EscalationPayload {
  escalation_type: "manual" | "authorization" | "decision";
  problem: string;
  call_to_action: string;

  // MANUAL-specific
  blocked_capability?: string;
  instructions?: string[];
  remediation_then_retry?: string;
  why_not_auto?: string;

  // AUTHORIZATION-specific
  recommendation?: string;
  risk?: string;
  why_asking?: string;
  could_higher_tier_resolve?: boolean;
  authorize_label?: string;

  // DECISION-specific
  options?: EscalationOption[];
  why_you?: string;

  // Optional passthrough fields (for auditing)
  observed?: Record<string, unknown>;
  attempts?: unknown[];
}

export interface NotificationComposition {
  short_text: string; // ≤140 char for push channel
  full_briefing: string; // markdown for dashboard
  ticket?: string;
  escalation_type: string;
}

/**
 * Truncates text to a max length, appending ellipsis if needed.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + "…";
}

/**
 * Formats options as a markdown table row.
 */
function formatOptionsTable(options: EscalationOption[]): string {
  if (options.length === 0) return "";
  const rows = [
    "| Option | Trade-off | Risk |",
    "|--------|-----------|------|",
    ...options.map(
      (opt) =>
        `| ${opt.label} | ${opt.tradeoff} | ${opt.risk || "—"} |`
    ),
  ];
  return rows.join("\n");
}

/**
 * Composes a notification from an escalation payload.
 * Returns {short_text, full_briefing, ticket, escalation_type}.
 *
 * Each type follows a distinct pattern:
 *
 * MANUAL: "CTL-NNN: {blocked_capability} required — {problem}"
 *   Background → Blocked capability → Steps → Trade-off → CTA
 *
 * AUTHORIZATION: "CTL-NNN: Approve {recommendation}? Risk: {risk}"
 *   Background → Why asking → Recommendation → Risk → CTA
 *
 * DECISION: "CTL-NNN: Choose path — {opt1} vs {opt2}"
 *   Background → Context → Options table → CTA
 */
export function composeNotification(
  ticket: string,
  escalation: EscalationPayload
): NotificationComposition | null {
  if (!escalation || !ticket) return null;

  const type = escalation.escalation_type;

  if (type === "manual") {
    return composeManualNotification(ticket, escalation);
  } else if (type === "authorization") {
    return composeAuthorizationNotification(ticket, escalation);
  } else if (type === "decision") {
    return composeDecisionNotification(ticket, escalation);
  }

  return null;
}

function composeManualNotification(
  ticket: string,
  e: EscalationPayload
): NotificationComposition {
  const capability = e.blocked_capability || "action";
  const instructions = Array.isArray(e.instructions) ? e.instructions : [];

  // Short text: capability + problem, truncated to 140 chars
  const shortText = truncate(
    `${ticket}: ${capability} required — ${e.problem}`,
    140
  );

  // Full briefing: professional, action-oriented
  const fullBriefing = [
    `## ${ticket}: ${capability} Required`,
    "",
    "### Background",
    e.problem,
    "",
    "### Blocked Capability",
    `**${capability}** is required to continue. This is beyond what the automation layer can handle.`,
    "",
    instructions.length > 0
      ? [
          "### Steps",
          instructions
            .map((instr, i) => `${i + 1}. ${instr}`)
            .join("\n"),
          "",
        ].join("\n")
      : "",
    "### Why Automation Can't Do This",
    e.why_not_auto ||
      "This decision requires human judgment or external approval.",
    "",
    "### Next Steps",
    `Once you've completed the steps above:\n\n${e.remediation_then_retry || "Retry the phase."}`,
    "",
    "**CTA**: " + e.call_to_action,
  ]
    .filter((s) => s !== "")
    .join("\n");

  return {
    short_text: shortText,
    full_briefing: fullBriefing,
    ticket,
    escalation_type: "manual",
  };
}

function composeAuthorizationNotification(
  ticket: string,
  e: EscalationPayload
): NotificationComposition {
  const recommendation = e.recommendation || "retry this ticket";
  const risk = e.risk || "unknown risk";

  // Short text: ask + decision, truncated to 140 chars
  const shortText = truncate(
    `${ticket}: Approve "${recommendation}"? Risk: ${risk}`,
    140
  );

  // Full briefing: why asking + recommendation + risk + CTA
  const fullBriefing = [
    `## ${ticket}: Authorization Required`,
    "",
    "### Background",
    e.problem,
    "",
    "### Why We're Asking",
    e.why_asking ||
      "The agent has exhausted its autonomous capability and needs your decision.",
    "",
    "### Our Recommendation",
    `**${recommendation}**`,
    "",
    "### Risk",
    risk,
    "",
    e.could_higher_tier_resolve
      ? "**Note**: A higher-tier model may be able to resolve this autonomously.\n"
      : "",
    "### Your Decision",
    `**${e.call_to_action || "Approve or cancel?"}**`,
  ]
    .filter((s) => s !== "")
    .join("\n");

  return {
    short_text: shortText,
    full_briefing: fullBriefing,
    ticket,
    escalation_type: "authorization",
  };
}

function composeDecisionNotification(
  ticket: string,
  e: EscalationPayload
): NotificationComposition {
  const options = Array.isArray(e.options) ? e.options : [];
  const optionLabels = options.map((opt) => opt.label).slice(0, 2);
  const optionSummary =
    optionLabels.length >= 2
      ? `${optionLabels[0]} vs ${optionLabels[1]}`
      : optionLabels[0] || "options";

  // Short text: "choose between", truncated to 140 chars
  const shortText = truncate(
    `${ticket}: Choose path — ${optionSummary}`,
    140
  );

  // Full briefing: background → context → options table → CTA
  const optionsTable =
    options.length > 0 ? formatOptionsTable(options) : "";

  const fullBriefing = [
    `## ${ticket}: Decision Needed`,
    "",
    "### Background",
    e.problem,
    "",
    "### Why You Decide",
    e.why_you ||
      "The agent cannot unilaterally choose between these paths. Your judgment is needed.",
    "",
    optionsTable ? ["### Options", optionsTable, ""].join("\n") : "",
    "### Your Decision",
    e.call_to_action ||
      "Review the options above and choose the best path forward.",
  ]
    .filter((s) => s !== "")
    .join("\n");

  return {
    short_text: shortText,
    full_briefing: fullBriefing,
    ticket,
    escalation_type: "decision",
  };
}
