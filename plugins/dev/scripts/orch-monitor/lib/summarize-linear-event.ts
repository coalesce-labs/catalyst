/**
 * Converts a linear.issue.* event into a one-line human-readable description.
 * Reads updatedFromKeys (the field names that changed) to disambiguate sub-types.
 *
 * Priority for multiple keys is already encoded in the event type by the parser
 * (stateId > assigneeId > priority), so the event type is the primary discriminator here.
 */
export function summarizeLinearEvent(
  eventType: string,
  ticket: string | undefined,
  updatedFromKeys: string[],
): string {
  const prefix = ticket ? `${ticket}: ` : "";

  switch (eventType) {
    case "linear.issue.state_changed": {
      if (updatedFromKeys.includes("startedAt")) return `${prefix}started`;
      if (updatedFromKeys.includes("completedAt")) return `${prefix}completed`;
      if (updatedFromKeys.includes("canceledAt")) return `${prefix}canceled`;
      return `${prefix}state changed`;
    }
    case "linear.issue.assignee_changed":
      return `${prefix}reassigned`;
    case "linear.issue.priority_changed":
      return `${prefix}priority changed`;
    case "linear.issue.updated": {
      if (updatedFromKeys.includes("title")) return `${prefix}title changed`;
      if (updatedFromKeys.includes("estimate")) return `${prefix}estimate changed`;
      return `${prefix}updated`;
    }
    case "linear.issue.created":
      return `${prefix}created`;
    case "linear.issue.removed":
      return `${prefix}removed`;
    default:
      if (eventType.startsWith("linear.issue_label.")) return "label updated";
      return `${prefix}${eventType.slice("linear.".length)}`.trim();
  }
}
