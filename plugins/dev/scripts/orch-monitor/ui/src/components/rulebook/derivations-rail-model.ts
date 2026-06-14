// derivations-rail-model.ts — CTL-1103 Phase 4: pure helper for the rail.
export function subjectToTicket(subject: string): string | null {
  if (!subject.includes("/")) return null;
  const ticket = subject.split("/")[0];
  return ticket.length > 0 ? ticket : null;
}
