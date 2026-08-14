// event-name.mjs — THE event-name boundary for ~/catalyst/events/YYYY-MM.jsonl.
//
// CTL-1834. Three envelope shapes coexist on the log and every consumer used to
// decide for itself which keys to look at, so a family of events could be visible
// to some readers and invisible to others:
//
//   v1  legacy flat        →  top-level `event`
//   v2  canonical OTel     →  `attributes["event.name"]`
//   v3  bare-name          →  top-level `name`
//
// MEASURED, full census of every log file ever written (4,034,067 parsed lines,
// 2026-04 through 2026-08):
//   • v2-only lines      2,857,537
//   • v1-only lines      1,175,111   (NOT legacy residue — `phase.terminal.reap-requested`
//                                     alone is 140,017 lines in 2026-08)
//   • v3-only lines          1,007   (`phase.rescue.*`, `phase.orphan-pr.detected.*`,
//                                     `ticket.completion.declared.*`)
//   • dual v1+v2 lines         322   (the CTL-1795 superset) — 322/322 AGREE
//
// Three separate v3 producers were each discovered and fixed REACTIVELY, one at a
// time, after their events had already been lost. This module plus its guard test
// is what makes the next shape drift fail at CI instead of on the log.
//
// ── WHY IT LIVES IN lib/ ────────────────────────────────────────────────────
// `lib/` is the zero-npm-import zone: `catalyst doctor` resolves its runtime as
// `command -v bun || command -v node` (catalyst-doctor:28) and must be able to
// import from here on bare Node, with no node_modules. This file imports nothing
// at all, so it is trivially loadable from every stack in the repo — the broker
// (whose package pulls pino + bun:sqlite), execution-core, orch-monitor and
// otel-forward TypeScript (via the event-name.d.mts sidecar, the same shape as
// lib/event-stream-class.d.mts), and bare-node CLIs.
//
// It was previously broker/event-name.mjs (CTL-1348, extracted so plugin-refresh
// stayed a leaf). That rationale is not weakened by this move — it is completed:
// execution-core/lib/dual-envelope.test.mjs already reached CROSS-TREE into
// ../../broker/event-name.mjs and only worked because the file happened to be
// import-free. lib/ is where an import-free leaf shared by four stacks belongs.
//
// ── KEY PRECEDENCE IS DELIBERATE ────────────────────────────────────────────
// `event` first, then `attributes["event.name"]`, then `name`. The first two are
// the order every shipped consumer already used, preserved so this change is a
// pure refactor: measured across all 4,034,067 lines, the ONLY behavioural delta
// is 1,007 lines that previously resolved to "" and now resolve to their real
// name — and none of those 1,007 names crosses a broker gate or handler branch.
//
// Order is UNOBSERVABLE today (all 322 dual lines carry identical values in both
// keys, and disagreement is not constructible: canonical_dual_envelope_line reads
// `name` from `.event` and passes that same string to --event-name). It is kept
// anyway because reordering the broker's routing read buys nothing and the dual
// population it would be justified from is 322 lines from a single day and a
// single service.
//
// NOTE for docs/architecture.md's CTL-1795 paragraph: the property that stops a
// dual line being routed twice is that it is ONE line, not the key order — one
// line resolves to one name and routes once under any ordering.
//
// ── FIRST NON-EMPTY STRING WINS, not `??` ───────────────────────────────────
// `??` only falls through on null/undefined, so `{"event": ""}` would shadow a
// real name sitting in `attributes`. Falling through on an empty or non-string
// value also matches the bash mirror in lib/canonical-event.sh
// (`_canonical_event_name_of`, which already tests `[[ -n "$n" ]]` at each rung)
// and resolves the 10 measured lines carrying `attributes["event.name"] === ""`
// toward a real name when one exists.
//
// The `typeof === "string"` test is ARMOR, not a repair: measured over those same
// 4,034,067 lines, a non-string `event` key has never occurred. It exists so a
// future one degrades to a miss rather than throwing inside `name.startsWith(...)`
// on the broker's hot routing path.

/**
 * The ordered discriminators, most-specific first, as DISPLAY PATHS.
 *
 * Exported so a mirror implementation's parity suite can assert against a
 * declared list rather than a re-typed literal, and so the guard test can assert
 * the implementation below spells exactly these three keys and no others.
 * These strings are not accessors — do not eval them.
 *
 * @type {readonly string[]}
 */
export const EVENT_NAME_KEYS = Object.freeze(["event", "attributes.event.name", "name"]);

/**
 * Resolve an event's name from any of the three envelope shapes.
 *
 * @param {unknown} event a parsed line from ~/catalyst/events/YYYY-MM.jsonl
 * @returns {string} the event name, or "" when no discriminator yields a
 *   non-empty string. Never throws, never returns a non-string.
 */
export function getEventName(event) {
  if (event === null || typeof event !== "object") return "";
  const v1 = event.event;
  if (typeof v1 === "string" && v1 !== "") return v1;
  const v2 = event.attributes?.["event.name"];
  if (typeof v2 === "string" && v2 !== "") return v2;
  const v3 = event.name;
  if (typeof v3 === "string" && v3 !== "") return v3;
  return "";
}
