// recovery-done-open-pr-event.mjs — CTL-1157 LOUD observability alarm:
// `recovery.done-applied-with-open-pr`.
//
// THE REVERSAL (owner's decision): the Done-safety mechanism is AGENT JUDGMENT,
// not a mechanical fail-closed block. The senior-engineer delegate enumerates a
// ticket's open PRs (via open-pr-gate.mjs) and reasons about each BEFORE it
// declares Done — finishing/merging the ones that are part of the solution and
// closing the abandoned ones itself. So the agent `declare` path is NOT gated.
//
// But two pure-CODE paths have no agent to reason: the execution-core terminal
// sweep (scheduler.mjs `terminalDoneOnce`) and the reconciler drain
// (linear-reconcile-cli.mjs `reconcile`). Per the reversal they must PROCEED —
// never wedge the board, never mechanically escalate — but when they would write
// Done while ≥1 OPEN PR still exists, they emit THIS event so we get the signal
// that would justify adding a real hard block later (held in reserve). A clean
// Done (0 open PRs) emits nothing.
//
// Loki (structured metadata — filter with `| field="…"`, NOT `{}` stream labels):
//   {service_namespace="catalyst"} | event_name="recovery.done-applied-with-open-pr"
//     | open_prs_count, pr_numbers, by, event_label   (ticket = event.label)
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { hostName } from "./lib/host-identity.mjs";

// defaultAppend — append a JSONL line to the canonical unified event log. Path is
// resolved the same way the rest of the reconciler emits (CATALYST_DIR, monthly
// rotation) so this module stays runtime-portable: it works under the daemon AND
// under the plain-node CLI without importing the bun-tinted config.mjs.
function defaultAppend(line) {
  const dir = process.env.CATALYST_DIR || join(homedir(), "catalyst");
  const d = new Date();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const file = join(dir, "events", `${month}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line);
}

// normalizePrNumbers — accepts the open-PR list (objects with `.number`) OR a raw
// array of numbers, returns a sorted unique number[] of OPEN PR numbers.
function normalizePrNumbers(openPrs = []) {
  const nums = (Array.isArray(openPrs) ? openPrs : [])
    .map((p) => (typeof p === "number" ? p : p?.number))
    .filter((n) => Number.isFinite(n));
  return [...new Set(nums)].sort((a, b) => a - b);
}

// buildRecoveryDoneOpenPrEvent — canonical OTel envelope (string + "\n"). The
// dimensions land in `attributes` so they forward to Loki as STRUCTURED METADATA
// (per-line, not stream labels): open_prs_count [value], pr_numbers [value],
// by [label], and event.label = ticket. severity WARN (loud).
export function buildRecoveryDoneOpenPrEvent({ ticket, openPrs = [], by = "unknown" } = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const prNumbers = normalizePrNumbers(openPrs);
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "WARN",
      severityNumber: 13,
      channel: "execution-core",
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": "recovery.done-applied-with-open-pr",
        "event.entity": "linear",
        "event.action": "done-applied-with-open-pr",
        // ticket = event_label (the owner's spec). Lower-cased mirror kept too so a
        // bare `| ticket="…"` filter works alongside `| event_label="…"`.
        "event.label": ticket,
        ticket,
        // [value] dimensions:
        open_prs_count: prNumbers.length,
        pr_numbers: prNumbers.map((n) => `#${n}`).join(","),
        // [label] dimension: WHICH pure-code backstop wrote the Done.
        by,
      },
      body: {
        payload: { ticket, by, open_prs_count: prNumbers.length, pr_numbers: prNumbers },
      },
    }) + "\n"
  );
}

// appendRecoveryDoneOpenPrEvent — emit the alarm. Best-effort + swallow-on-error
// (observability must NEVER abort a write or wedge the tick). The `append` seam
// defaults to the real file write; inject a recorder in tests. Returns true on
// success, false on any error. No-op (returns false, emits nothing) when there are
// zero open PRs — a clean Done is silent.
export function appendRecoveryDoneOpenPrEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    if (normalizePrNumbers(fields.openPrs).length === 0) return false;
    append(buildRecoveryDoneOpenPrEvent(fields));
    return true;
  } catch {
    return false; // never throw from an observability emit
  }
}

// ── CTL-1157 SLICE 3 — the broad "Done-moves" event: `recovery.done-applied` ───
//
// Unlike the loud `recovery.done-applied-with-open-pr` alarm above (the open-PR
// SUBSET), THIS event fires on EVERY autonomous Done so OTEL has a "Done-moves"
// panel — the delegate's clean Done declarations AND the two pure-code backstops.
// The red-line is `open_prs_at_done > 0`: a clean Done (the agent finished/closed
// every open PR before declaring) carries 0 and is INFO; a Done that lands while a
// PR is still open carries >0 and is WARN — the same signal the alarm watches, now
// also visible as a chartable rate across every Done. open_prs_at_done is the
// count STILL open at the Done write; prs_closed / prs_kept are what the agent did
// during its PR-2 remediation (0/0 for the no-agent pure-code paths).
//
// SHADOW-SAFE: in shadow the delegate does not write Done — the caller passes
// recoveryMode:"shadow" and we emit `recovery.would-done-applied` (would-apply
// telemetry, INFO, no write happened). In enforce the real write emits
// `recovery.done-applied`. recoveryMode is BOTH the name selector and the
// recovery_mode label, mirroring the recovery-reasoning shadow/enforce precedent.
//
// Loki (structured metadata — `| field="…"`, NOT `{}` stream labels):
//   {service_namespace="catalyst"} | event_name="recovery.done-applied"
//     | open_prs_at_done > 0           ← the red-line
//   sum by (by) (count_over_time({…} | event_name="recovery.done-applied" [1d]))
//
// dimensions: open_prs_at_done [value] · prs_closed [value] · prs_kept [value] ·
//             recovery_mode [label] · host_name [label] · by [label] ·
//             event.label = ticket.
const toCount = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);

export function buildRecoveryDoneAppliedEvent({
  ticket,
  openPrsAtDone = 0,
  prsClosed = 0,
  prsKept = 0,
  recoveryMode = "enforce",
  by = "unknown",
  host = hostName(),
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const openCount = toCount(openPrsAtDone);
  const shadow = recoveryMode === "shadow";
  const name = shadow ? "recovery.would-done-applied" : "recovery.done-applied";
  const action = shadow ? "would-done-applied" : "done-applied";
  // The red-line: a Done that lands with ≥1 open PR is WARN (mirrors the alarm's
  // severity). A clean Done — and any shadow would-apply — stays INFO.
  const redLine = !shadow && openCount > 0;
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: redLine ? "WARN" : "INFO",
      severityNumber: redLine ? 13 : 9,
      channel: "execution-core",
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": name,
        "event.entity": "linear",
        "event.action": action,
        // ticket = event_label (the owner's spec); lower-cased mirror kept too.
        "event.label": ticket,
        ticket,
        // [value] dimensions — chartable counts:
        open_prs_at_done: openCount,
        prs_closed: toCount(prsClosed),
        prs_kept: toCount(prsKept),
        // [label] dimensions:
        recovery_mode: recoveryMode,
        host_name: host,
        by,
      },
      body: {
        payload: {
          ticket,
          by,
          open_prs_at_done: openCount,
          prs_closed: toCount(prsClosed),
          prs_kept: toCount(prsKept),
          recovery_mode: recoveryMode,
          host_name: host,
        },
      },
    }) + "\n"
  );
}

// appendRecoveryDoneAppliedEvent — emit the Done-moves event. Best-effort +
// swallow-on-error (observability must NEVER abort a Done write or wedge a tick).
// Unlike the open-PR alarm this is NOT conditional on open PRs — it fires on every
// autonomous Done. Returns true on success, false on any error.
export function appendRecoveryDoneAppliedEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    append(buildRecoveryDoneAppliedEvent(fields));
    return true;
  } catch {
    return false; // never throw from an observability emit
  }
}
