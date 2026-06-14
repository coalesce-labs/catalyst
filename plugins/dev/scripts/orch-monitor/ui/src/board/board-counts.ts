/** CTL-1144: board-header total count, thousands-grouped + pluralized. */
export function formatIssueCount(n: number): string {
  return `${n.toLocaleString("en-US")} issue${n === 1 ? "" : "s"}`;
}
