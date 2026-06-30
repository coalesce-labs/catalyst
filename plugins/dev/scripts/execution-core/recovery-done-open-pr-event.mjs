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
