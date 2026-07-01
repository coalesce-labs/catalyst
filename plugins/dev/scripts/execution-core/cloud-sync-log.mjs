// cloud-sync-log.mjs — CTL-1402: pure helper that decides how an SDK
// `log(level, msg, extra)` call maps to a pino record. Extracted from cloud-sync.mjs
// (which runs the daemon on import, so it can't be imported into a test) so the
// apply-result routing is unit-testable.
//
// Why it matters: the SDK's apply-result signal arrives as
// `("info"|"error", "catalyst.replica.apply", {result, seq, entity, source, err_message?})`.
// It MUST become a full-JSON pino line with those fields at TOP LEVEL so Alloy's
// `loki.process.pino` (which keeps the full JSON body) exposes them to `| json` — a
// prefixed `console.log` string ships as an opaque body and its fields never register.

const PINO_LEVELS = new Set(["info", "warn", "error"]);

// sdkLogRecord(level, msg, extra, scrub) → { level, msg, fields }
//   level  — normalized pino method name ("error" | "warn" | otherwise "info")
//   msg    — scrubbed message string (pino's second arg)
//   fields — the pino merging object (top-level fields), or undefined when there is none.
//            An object `extra` is spread to top level (string values scrubbed); a
//            non-object `extra` rides a single `detail` field; `undefined` → no fields.
// `scrub` defaults to identity so the pure shape can be tested without the secret regexes.
export function sdkLogRecord(level, msg, extra, scrub = (x) => String(x)) {
  const lvl = PINO_LEVELS.has(level) ? level : "info";
  const smsg = scrub(msg);
  if (extra === undefined) return { level: lvl, msg: smsg, fields: undefined };
  if (extra && typeof extra === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(extra)) fields[k] = typeof v === "string" ? scrub(v) : v;
    return { level: lvl, msg: smsg, fields };
  }
  return { level: lvl, msg: smsg, fields: { detail: scrub(String(extra)) } };
}
