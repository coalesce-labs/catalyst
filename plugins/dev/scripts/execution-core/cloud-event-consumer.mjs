#!/usr/bin/env bun
// cloud-event-consumer.mjs — CTL-1534: the phase-3 SHADOW consumer of the
// catalyst-cloud event feed.
//
// WHAT
// ----
// Polls `GET <baseUrl>/events/stream?since=<seq>` (NDJSON, per-host bearer),
// maps each RAW provider payload through the EXISTING, UNMODIFIED orch-monitor
// webhook mappers, and appends the resulting v2 envelopes to a SHADOW event log
// at `~/catalyst/events-shadow/YYYY-MM.jsonl`.
//
// It NEVER writes `~/catalyst/events/`. That is enforced by construction, not by
// convention: the shadow directory name is a module constant, no caller can pass
// a directory path, and `resolveShadowDir()` refuses any resolution that lands on
// or inside the live events dir. Writing the live log would double-wake every
// worker in the fleet.
//
// THE MAPPERS ARE REUSED, NEVER REIMPLEMENTED (project invariant 2). Both the
// smee path and this path run identical mapping code, so any shadow-vs-live diff
// is *transport or coverage* — never mapping. See the four imports below; if you
// find yourself writing a `switch (eventType)` in this file, stop.
//
// THE JOIN KEY is `attributes["webhook.delivery.id"]` (CTL-1532), stamped here
// from the feed's `deliveryId` exactly as the live handlers stamp it from
// `x-github-delivery` / `linear-delivery`. Verified end-to-end: the same value
// reaches both transports, for both providers.
//
// THE ORDERING KEY is `attributes[SEQ_ATTR]` (= "catalyst.cloud.event.seq"),
// stamped here from the feed's `seq`. It is the ONLY input to parity-harness's
// SEQ_WIRE_ORDER / SEQ_CONTIGUITY / SEQ_COVERAGE assertions: if this producer
// stops stamping it, those three questions cannot be answered and the harness
// hard-blocks (exit 2) rather than passing on an attribute nobody wrote. The
// two halves of this deliverable agree on exactly one string, exported here and
// asserted against the harness default in the test suite.
//
// THREE-WAY EXIT CONTRACT (non-negotiable; see HARNESS RULES below)
//   0 = evaluated, healthy
//   1 = evaluated, problem found
//   2 = COULD NOT EVALUATE
// "I could not check" must NEVER render as "healthy". A failed probe, an auth
// error, a control record, a missing head header, or bad input is 2 — never 0.
// When a run both fails to evaluate part of the range AND finds a problem in the
// part it did evaluate, 2 wins (and both counts are printed, so neither hides).
//
// HARNESS RULES this file implements — every one comes from a real defect found
// in catalyst-cloud's equivalent harness, each of which produced a confident green:
//   1. three-way exit (above)
//   2. COVERAGE != INTEGRITY, asserted SEPARATELY. A 200 that starts after
//      since+1, ends before head, or is empty while head is ahead is internally
//      contiguous and carries NO control record. Contiguity cannot see it at any
//      level of rigour.
//   3. a CONTROL RECORD invalidates the run -> exit 2 (the received prefix is
//      contiguous, so a naive gap check passes a server-declared incomplete scan)
//   4. adjacency is checked in WIRE ORDER. Nothing is ever sorted.
//   5. per-source, per-type COUNTS (never presence); `--require-source` asserts
//      non-zero per named source
//   6. the evidence is NEVER normalised — no coercion, no defaulting, no sorting.
//      Bad input is rejected with exit 2, never repaired.
//   7. `--since` / a persisted cursor from day one (a hardcoded 0 409s forever
//      once retention evicts)
//   8. `--self-test` is the negative control: credential-free, offline, CI-runnable,
//      and OBSERVED to go red on every seeded failure.
//
// SECRETS: the token is read from ~/.config/catalyst/cloud-sync.env
// (CATALYST_CLOUD_TOKEN) or the environment, and is NEVER logged. Every log line
// and every report string passes through a scrubber bound to the live token value.

import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// THE MAPPERS — imported UNMODIFIED from orch-monitor. Do not fork these.
// ---------------------------------------------------------------------------
import { parseWebhookEvent } from "../orch-monitor/lib/webhook-events.ts";
import { buildEventLogEnvelope } from "../orch-monitor/lib/webhook-handler.ts";
import { parseLinearWebhookEvent } from "../orch-monitor/lib/linear-webhook-events.ts";
import { buildLinearEventLogEnvelope } from "../orch-monitor/lib/linear-webhook-handler.ts";
import { readClusterProjects } from "../orch-monitor/lib/cluster-roster.ts";

export const TAG = "[cloud-event-consumer]";

/** The ONLY directory this consumer may write. Hardcoded, never a parameter. */
export const SHADOW_DIR_NAME = "events-shadow";
/** The live log. Named here only so we can refuse to resolve onto it. */
export const LIVE_DIR_NAME = "events";

export const DEFAULT_BASE_URL = "https://staging.catalystcloud.dev";
export const DEFAULT_STREAM_PATH = "/events/stream";
export const DEFAULT_POLL_MS = 10_000;
/** Bounded persisted dedup ring. Retains the most recent N delivery ids. */
export const DEFAULT_DEDUP_MAX = 5000;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
export const STATE_FILE_NAME = ".cloud-event-consumer.cursor.json";
export const STATE_VERSION = 1;

/** Exit codes. 2 dominates 1 dominates 0 — "could not evaluate" never collapses. */
export const EXIT_HEALTHY = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_UNEVALUATED = 2;

/** Marker names written into the shadow log. Never a CTL-1142 protected prefix. */
export const MARKER_UNMAPPABLE = "catalyst.cloud_feed.unmappable_payload";
export const MARKER_FEED_GAP = "catalyst.cloud_feed.gap";

/**
 * The transport-ordering attribute stamped on EVERY shadow envelope. This is the
 * producer half of a two-party contract: parity-harness.mjs defaults --seq-attr
 * to this exact string and its whole ordering/coverage subsystem reads it. Both
 * halves are pinned together by a test (`SEQ_ATTR === parseArgs([]).opts.seqAttr`)
 * so a rename on either side breaks the suite instead of silently disabling three
 * assertions.
 */
export const SEQ_ATTR = "catalyst.cloud.event.seq";

/** The cloud edge cap. A payloadOmitted record must be at least this large. */
export const PAYLOAD_CAP_BYTES = 96 * 1024;

/**
 * The DECLARED per-source provider-type census (rule 9: classify against a
 * declared expectation, never against presence).
 *
 *  - declared-mappable   — webhook-events.ts has a case for it. If records of
 *                          this type arrive and NOTHING is appended for it, that
 *                          is a mapper/schema regression, not "coverage data".
 *  - declared-unmappable — no mapper on EITHER path (so the live log has no such
 *                          envelope either). Structurally invisible, expected-zero.
 *  - anything else       — UNDECLARED: a cloud-side schema/casing change. Loud.
 *
 * Mirrors parity-harness's UNMAPPABLE_PROVIDER_TYPES; the lists are asserted
 * equal in the test suite so they cannot drift apart silently.
 */
export const DECLARED_MAPPABLE_TYPES = {
  github: new Set([
    "pull_request", "pull_request_review", "pull_request_review_thread", "check_suite",
    "status", "push", "issue_comment", "pull_request_review_comment", "deployment",
    "deployment_status", "release", "workflow_run",
  ]),
  linear: new Set([
    "Issue", "Comment", "Cycle", "Reaction", "IssueLabel", "AgentSessionEvent",
    "issueCommentMention",
  ]),
};
export const DECLARED_UNMAPPABLE_TYPES = {
  github: new Set(["workflow_job", "check_run"]),
  linear: new Set(["Attachment"]),
};

/** "declared-mappable" | "declared-unmappable" | "undeclared" */
export function classifyProviderType(source, eventType) {
  if (DECLARED_MAPPABLE_TYPES[source]?.has(eventType)) return "declared-mappable";
  if (DECLARED_UNMAPPABLE_TYPES[source]?.has(eventType)) return "declared-unmappable";
  return "undeclared";
}

// ---------------------------------------------------------------------------
// Strict parsing. Rule 6: reject, never repair.
// ---------------------------------------------------------------------------

/** Canonical non-negative integer, decimal, no sign, no whitespace, no exponent. */
const INT_RE = /^(0|[1-9][0-9]*)$/;

/**
 * parseSinceArg — strict `--since` / cursor parse. Returns a number, or null for
 * ANYTHING else. Deliberately NOT `Number()`: `Number("banana")` is NaN, which a
 * server normalises to 0, which silently scans the whole feed and reports healthy
 * about a range nobody asked for. That was a real defect.
 */
export function parseSinceArg(raw) {
  if (typeof raw !== "string") return null;
  if (!INT_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * strictSeq — a wire `seq` must already be a safe non-negative integer NUMBER.
 * A string "12", a float, a NaN, or a missing value is bad input: return null and
 * let the caller exit 2. We never coerce the evidence into something checkable.
 */
export function strictSeq(value) {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** strictHeader — parse `x-catalyst-event-head-seq`. null when absent/malformed. */
export function parseHeadHeader(raw) {
  if (typeof raw !== "string") return null;
  return parseSinceArg(raw);
}

// ---------------------------------------------------------------------------
// Paths. The shadow dir is impossible to point at the live log.
// ---------------------------------------------------------------------------

export function defaultCatalystDir(env = process.env) {
  return env.CATALYST_DIR ?? resolve(homedir(), "catalyst");
}

/**
 * resolveShadowDir — the ONLY way to obtain a write directory. Callers supply the
 * catalyst root, never a directory: the last segment is the hardcoded
 * SHADOW_DIR_NAME. Refuses any resolution that equals the live events dir or sits
 * inside it (which a `CATALYST_DIR=.../events` would otherwise produce).
 */
export function resolveShadowDir(catalystDir) {
  if (typeof catalystDir !== "string" || catalystDir.length === 0) {
    throw new Error("resolveShadowDir: catalystDir must be a non-empty string");
  }
  const root = resolve(catalystDir);
  const dir = resolve(root, SHADOW_DIR_NAME);
  const live = resolve(root, LIVE_DIR_NAME);
  if (basename(dir) !== SHADOW_DIR_NAME) {
    throw new Error(`refusing shadow dir with unexpected basename: ${dir}`);
  }
  if (dir === live || dir.startsWith(live + sep)) {
    throw new Error(`refusing shadow dir that resolves onto the LIVE event log: ${dir}`);
  }
  // Defence in depth: the resolved dir must not itself be named `events`, nor
  // have `events` as its immediate parent.
  if (basename(dirname(dir)) === LIVE_DIR_NAME) {
    throw new Error(`refusing shadow dir nested under a live events dir: ${dir}`);
  }
  // CTL-1534 (M10): every check above is LEXICAL, and `resolve()` does not follow
  // symlinks. If `<root>/events-shadow` is a symlink to `<root>/events`, all of
  // them pass and we write straight into the LIVE event log — double-waking every
  // worker, the single worst outcome this tool can produce. Re-check on REAL paths.
  //
  // A symlink at the shadow path is refused outright rather than resolved: there is
  // no legitimate reason for it, and refusing is simpler to reason about than
  // deciding which targets are acceptable.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
    throw new Error(`refusing shadow dir that is a symlink: ${dir}`);
  }
  const realOf = (p) => {
    // realpath the deepest existing ancestor, so the guard works before mkdir.
    let cur = p;
    for (;;) {
      if (existsSync(cur)) return resolve(realpathSync(cur), p.slice(cur.length));
      const parent = dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  };
  const realDir = realOf(dir);
  const realLive = realOf(live);
  if (realDir === realLive || realDir.startsWith(realLive + sep)) {
    throw new Error(
      `refusing shadow dir that RESOLVES onto the LIVE event log: ${dir} -> ${realDir}`,
    );
  }
  return dir;
}

export function shadowFilePath(catalystDir, date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  // CTL-1534 (M10): distinct basename from the live log (`YYYY-MM.jsonl`). Even if
  // every directory guard above were defeated, a shadow write can then never
  // overwrite or be mistaken for a live event-log file.
  return resolve(resolveShadowDir(catalystDir), `shadow-${y}-${m}.jsonl`);
}

export function statePath(catalystDir) {
  return resolve(catalystDir, STATE_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Token. Never logged.
// ---------------------------------------------------------------------------

export function defaultCloudSyncEnvPath(env = process.env) {
  const dir = env.CATALYST_CONFIG_DIR || resolve(homedir(), ".config", "catalyst");
  return resolve(dir, "cloud-sync.env");
}

/**
 * parseEnvFile — minimal `KEY=value` / `export KEY=value` reader. Strips one
 * layer of matching single or double quotes. Comments and blanks ignored.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m === null) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * readCloudToken — env var first (so a supervisor can inject), then the 0600
 * cloud-sync.env. Returns "" when unresolvable. NEVER logs or returns a partial
 * token in an error string.
 */
export function readCloudToken(opts = {}) {
  const {
    env = process.env,
    envFilePath = defaultCloudSyncEnvPath(env),
    readFile = (p) => readFileSync(p, "utf8"),
  } = opts;
  const fromEnv = env.CATALYST_CLOUD_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { token: fromEnv, source: "env" };
  }
  let text;
  try {
    text = readFile(envFilePath);
  } catch {
    return { token: "", source: "absent" };
  }
  const parsed = parseEnvFile(text);
  const t = parsed.CATALYST_CLOUD_TOKEN;
  return typeof t === "string" && t.length > 0
    ? { token: t, source: "file" }
    : { token: "", source: "absent" };
}

/** makeScrubber — redact the live token (and any bearer/token-shaped substring). */
export function makeScrubber(token) {
  return (value) => {
    let s = typeof value === "string" ? value : String(value);
    if (typeof token === "string" && token.length >= 8) {
      s = s.split(token).join("<redacted>");
    }
    return s
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
      .replace(/([?&]token=)[^&\s]+/gi, "$1<redacted>");
  };
}

// ---------------------------------------------------------------------------
// State: cursor + bounded persisted dedup ring. Atomic tmp + rename.
// ---------------------------------------------------------------------------

export function emptyState() {
  return { version: STATE_VERSION, cursor: null, updatedAt: null, seenDeliveryIds: [] };
}

/**
 * readState — returns {state, ok, reason}. A CORRUPT state file is NOT silently
 * replaced with a fresh one: `ok:false` so the caller exits 2. Silently resetting
 * a cursor is exactly the "quietly repaired the input" defect class.
 */
export function readState(catalystDir, opts = {}) {
  const { readFile = (p) => readFileSync(p, "utf8") } = opts;
  let text;
  try {
    text = readFile(statePath(catalystDir));
  } catch {
    return { state: emptyState(), ok: true, reason: "absent" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: null, ok: false, reason: "unparseable-state-file" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: null, ok: false, reason: "state-file-not-an-object" };
  }
  if (parsed.version !== STATE_VERSION) {
    return { state: null, ok: false, reason: `unknown-state-version:${String(parsed.version)}` };
  }
  const cursor = parsed.cursor === null ? null : strictSeq(parsed.cursor);
  if (parsed.cursor !== null && cursor === null) {
    return { state: null, ok: false, reason: "state-cursor-not-a-safe-integer" };
  }
  const ids = parsed.seenDeliveryIds;
  if (!Array.isArray(ids) || ids.some((v) => typeof v !== "string")) {
    return { state: null, ok: false, reason: "state-seenDeliveryIds-malformed" };
  }
  return {
    state: {
      version: STATE_VERSION,
      cursor,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      seenDeliveryIds: ids,
    },
    ok: true,
    reason: "read",
  };
}

/** writeState — atomic tmp + rename, so a crash can never leave a half cursor. */
export function writeState(catalystDir, state, opts = {}) {
  const {
    dedupMax = DEFAULT_DEDUP_MAX,
    now = () => new Date(),
    mkdir = (d) => mkdirSync(d, { recursive: true }),
    writeFile = (p, s) => writeFileSync(p, s),
    rename = (a, b) => renameSync(a, b),
  } = opts;
  const dest = statePath(catalystDir);
  const ids = state.seenDeliveryIds.slice(-dedupMax);
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      cursor: state.cursor,
      updatedAt: now().toISOString(),
      seenDeliveryIds: ids,
    },
    null,
    2,
  );
  mkdir(dirname(dest));
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFile(tmp, body + "\n");
  rename(tmp, dest);
  return { path: dest, cursor: state.cursor, retainedIds: ids.length };
}

// ---------------------------------------------------------------------------
// Shadow appender. Hardcoded dir; the only write surface.
// ---------------------------------------------------------------------------

export function createShadowAppender(catalystDir, opts = {}) {
  const {
    now = () => new Date(),
    mkdir = (d) => mkdirSync(d, { recursive: true }),
    append = (p, s) => appendFileSync(p, s),
  } = opts;
  // Resolve (and validate) once at construction so a bad root fails loudly before
  // a single line is written.
  const dir = resolveShadowDir(catalystDir);
  let lines = 0;
  return {
    dir,
    get lines() {
      return lines;
    },
    write(record) {
      const path = shadowFilePath(catalystDir, now());
      mkdir(dir);
      append(path, JSON.stringify(record) + "\n");
      lines += 1;
      return path;
    },
  };
}

// ---------------------------------------------------------------------------
// Line classification. Invariant 8: EVERY event line has `seq`; NO control line
// does. `!("seq" in line)` is the contract. `error` only appears at the envelope
// top level — provider JSON is nested under `payload`, so a provider body with
// its own `error` key surfaces at `line.payload.error` and cannot collide.
// Ambiguous lines fail toward reconcile.
// ---------------------------------------------------------------------------

export function classifyLine(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "line is not a JSON object" };
  }
  const hasSeq = "seq" in parsed;
  const hasError = "error" in parsed;
  if (hasError && !hasSeq) return { kind: "control", record: parsed };
  if (!hasSeq) return { kind: "invalid", reason: "line has neither seq nor error" };
  if (hasError && hasSeq) {
    // Never seen in the wild and not in the contract. Fail toward reconcile.
    return { kind: "control", record: parsed, ambiguous: true };
  }
  return { kind: "event", record: parsed };
}

/**
 * isPayloadOmitted — TRUTHY test, never key-presence. On a normal event the field
 * is ABSENT (not `false`); branching on `"payloadOmitted" in line` would classify
 * every normal event as unmappable. Verified parser detail from the wire.
 */
export function isPayloadOmitted(record) {
  return Boolean(record.payloadOmitted);
}

// ---------------------------------------------------------------------------
// NDJSON reading. Streams when the response exposes a body; falls back to text().
// Both paths are exercised by the test suite.
// ---------------------------------------------------------------------------

export async function* ndjsonLines(response) {
  const body = response.body;
  const getReader = body && typeof body.getReader === "function" ? body.getReader.bind(body) : null;
  if (getReader === null) {
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.length > 0) yield line;
    }
    return;
  }
  const reader = getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) yield buf;
}

// ---------------------------------------------------------------------------
// Bot-actor suppression, mirroring the live Linear handler so the parity join is
// not polluted by rows the live path deliberately never appends. This is HANDLER
// policy, not mapping — the mapper stays untouched.
// ---------------------------------------------------------------------------

export function readLinearBotUserIds(opts = {}) {
  const {
    env = process.env,
    readFile = (p) => readFileSync(p, "utf8"),
    layer2Path = resolve(
      env.CATALYST_CONFIG_DIR || resolve(homedir(), ".config", "catalyst"),
      "config.json",
    ),
    layer1Path = resolve(env.CATALYST_PROJECT_DIR || process.cwd(), ".catalyst", "config.json"),
  } = opts;
  const ids = new Set();
  const load = (p) => {
    try {
      const parsed = JSON.parse(readFile(p));
      return parsed !== null && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };
  const l2 = load(layer2Path);
  const bot = l2?.catalyst?.linear?.bot;
  for (const slot of ["worker", "orchestrator"]) {
    const id = bot?.[slot]?.botUserId;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  const l1 = load(layer1Path);
  const legacy = l1?.catalyst?.monitor?.linear?.botUserId ?? l1?.monitor?.linear?.botUserId;
  if (typeof legacy === "string" && legacy.length > 0) ids.add(legacy);
  return ids;
}

// ---------------------------------------------------------------------------
// Mapping a single cloud record -> a v2 envelope, via the UNMODIFIED mappers.
// ---------------------------------------------------------------------------

/**
 * mapCloudEvent — turn one feed record into a v2 envelope.
 *
 * Returns one of:
 *   {outcome:"envelope", envelope}
 *   {outcome:"unmappable", reason}          // payloadOmitted — a targeted GAP
 *   {outcome:"ignored", reason}             // the mapper declined it (coverage data)
 *   {outcome:"bot-suppressed"}              // live path suppresses it too
 *   {outcome:"invalid", reason}             // malformed record -> caller exits 2
 *
 * `tsMode`:
 *   "receivedAt" (default) — envelope.ts = the cloud's edge receipt time. Makes the
 *      shadow log temporally comparable to the live one.
 *   "now" — envelope.ts = wall clock at map time, matching what the live handler
 *      does (it passes `undefined`). Replay then stamps replay-time, which is why
 *      it is not the default.
 * Either way `ts` is NOT a parity field; the join key is webhook.delivery.id.
 */
export function mapCloudEvent(record, opts = {}) {
  const { teamsMap = new Map(), tsMode = "receivedAt", botUserIds = new Set(), now = () => new Date() } = opts;

  const source = record.source;
  if (source !== "github" && source !== "linear") {
    return { outcome: "invalid", reason: `unknown source: ${JSON.stringify(source)}` };
  }
  const eventType = record.eventType;
  if (typeof eventType !== "string" || eventType.length === 0) {
    return { outcome: "invalid", reason: "missing eventType" };
  }
  const deliveryId = record.deliveryId;
  if (typeof deliveryId !== "string" || deliveryId.length === 0) {
    return { outcome: "invalid", reason: "missing deliveryId (the ONLY join key)" };
  }
  // The ordering key. Rejected, never defaulted: an envelope with no seq would
  // silently disable the harness's entire ordering/coverage subsystem, which is
  // exactly the "the check evaluated nothing and passed" class this file exists
  // to prevent.
  const seq = strictSeq(record.seq);
  if (seq === null) {
    return {
      outcome: "invalid",
      reason: `seq is not a safe non-negative integer: ${JSON.stringify(record.seq)} (the ONLY ordering key)`,
    };
  }

  if (isPayloadOmitted(record)) {
    return { outcome: "unmappable", reason: "payloadOmitted" };
  }
  if (record.payload === null || typeof record.payload !== "object") {
    // Not the documented elision shape and not a mappable body. Do not guess.
    return { outcome: "invalid", reason: "payload is absent but payloadOmitted is not truthy" };
  }

  let ts;
  if (tsMode === "receivedAt") {
    const parsedTs = toIsoOrNull(record.receivedAt);
    if (parsedTs === null) return { outcome: "invalid", reason: "receivedAt is not a usable timestamp" };
    ts = parsedTs;
  } else if (tsMode === "now") {
    ts = now().toISOString();
  } else {
    return { outcome: "invalid", reason: `unknown tsMode: ${String(tsMode)}` };
  }

  let envelope = null;
  if (source === "github") {
    const parsed = parseWebhookEvent(eventType, record.payload);
    if (parsed.kind === "ignored") return { outcome: "ignored", reason: parsed.reason };
    // NOTE: the live path may consult a SHA->PR cache here for check_suite /
    // workflow_run with no inline pull_requests. The shadow has no such cache;
    // those events are counted as `prCacheDependent` by the caller so the
    // resulting attribute diff is a KNOWN coverage delta, not a mystery.
    envelope = buildEventLogEnvelope(parsed, ts);
  } else {
    const parsed = parseLinearWebhookEvent(eventType, record.payload);
    if (parsed.kind === "ignored") return { outcome: "ignored", reason: parsed.reason };
    if (parsed.kind === "issue" && parsed.actorId !== null && botUserIds.has(parsed.actorId)) {
      return { outcome: "bot-suppressed" };
    }
    envelope = buildLinearEventLogEnvelope(parsed, ts, teamsMap);
  }
  if (envelope === null) return { outcome: "ignored", reason: "builder returned null" };

  // CTL-1532 join key, stamped exactly as the live handlers stamp it.
  envelope.attributes["webhook.delivery.id"] = deliveryId;
  // Transport ordering key (the harness's --seq-attr). The smee side structurally
  // cannot carry it, so parity-harness excludes it from ENVELOPE_EQUIVALENCE by
  // declaration (`ignoredAttrs`), not by accident.
  envelope.attributes[SEQ_ATTR] = seq;
  return { outcome: "envelope", envelope };
}

function toIsoOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** True when the live path would have consulted its SHA->PR cache for this event. */
export function needsPrCache(source, eventType, payload) {
  if (source !== "github") return false;
  if (eventType !== "check_suite" && eventType !== "workflow_run") return false;
  const parsed = parseWebhookEvent(eventType, payload);
  if (parsed.kind !== "check_suite" && parsed.kind !== "workflow_run") return false;
  return parsed.prNumbers.length === 0 && Boolean(parsed.headSha);
}

// ---------------------------------------------------------------------------
// One poll pass.
// ---------------------------------------------------------------------------

export function newReport(since) {
  return {
    status: EXIT_HEALTHY,
    since,
    headSeq: null,
    firstSeq: null,
    lastSeq: null,
    received: 0,
    appended: 0,
    deduped: 0,
    // COVERAGE and INTEGRITY are SEPARATE. Requirement: a clean EOF is
    // indistinguishable from a complete answer to any contiguity check.
    coverage: { ok: null, problems: [] },
    integrity: { ok: null, breaks: [] },
    // WIRE census — what arrived. Seeded at zero for both sources so "linear
    // delivered nothing" is a printed row, not an absent key (rule 9/10).
    bySource: { github: 0, linear: 0 },
    byType: {},
    // APPENDED census — what actually reached the shadow log. Every non-zero
    // assertion reads THESE, never the wire census: a record that arrived and was
    // then declined, suppressed or deduped contributed nothing to parity.
    appendedBySource: { github: 0, linear: 0 },
    appendedByType: {},
    unmappable: [],
    ignoredByType: {},
    undeclaredTypes: {},
    markersWritten: 0,
    prCacheDependent: 0,
    botSuppressed: 0,
    control: null,
    unevaluated: [],
    problems: [],
    cursorAdvancedTo: null,
  };
}

function bump(obj, key) {
  obj[key] = (obj[key] ?? 0) + 1;
}

function markUnevaluated(report, reason) {
  report.unevaluated.push(reason);
  report.status = EXIT_UNEVALUATED;
}

function markProblem(report, reason) {
  report.problems.push(reason);
  // 2 dominates 1 — an unevaluated run must never be downgraded to "problem",
  // and a problem must never be upgraded to healthy.
  if (report.status !== EXIT_UNEVALUATED) report.status = EXIT_PROBLEM;
}

/**
 * runOnce — a single poll pass. Never throws for an expected failure mode; every
 * failure is folded into `report.status` per the three-way contract.
 *
 * ctx:
 *   fetchImpl(url, init) -> Response-like
 *   baseUrl, token, since
 *   appender  ({write(record)})
 *   teamsMap, botUserIds, tsMode
 *   seen      (Set<string> of delivery ids; mutated)
 *   log       ({info,warn,error})
 */
export async function runOnce(ctx) {
  const {
    fetchImpl,
    baseUrl = DEFAULT_BASE_URL,
    streamPath = DEFAULT_STREAM_PATH,
    token,
    since,
    appender,
    teamsMap = new Map(),
    botUserIds = new Set(),
    tsMode = "receivedAt",
    seen,
    log = console,
    scrub = (s) => s,
    requireSources = [],
  } = ctx;

  const report = newReport(since);

  if (strictSeq(since) === null) {
    markUnevaluated(report, `since is not a safe non-negative integer: ${JSON.stringify(since)}`);
    return report;
  }

  const url = `${String(baseUrl).replace(/\/+$/, "")}${streamPath}?since=${since}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/x-ndjson",
      },
    });
  } catch (err) {
    markUnevaluated(report, `fetch threw: ${scrub(err?.message ?? String(err))}`);
    return report;
  }

  const status = res.status;

  if (status === 409) {
    // BOTH 409s are LOUD and terminal. Neither is a transient to shrug off, and
    // NEITHER auto-repairs the cursor: clamping to head would be normalising the
    // evidence and would silently skip a real range.
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    const kind = body && typeof body.error === "string" ? body.error : "unknown-409";
    if (kind === "cursor_underflow") {
      markUnevaluated(report, "409 cursor_underflow — RECONCILE REQUIRED, not resume");
      report.control = { source: "http-409", ...(body ?? {}) };
      log.error?.(
        scrub(
          `${TAG} 409 cursor_underflow at since=${since}: retention has evicted our cursor. ` +
            `This is a RECONCILE signal, NOT a resume. The cursor is left UNCHANGED. ` +
            `Re-point it deliberately (--since <seq>) after reconciling the gap.`,
        ),
      );
      appender?.write(
        gapMarker({
          reason: "cursor_underflow",
          detail: "409 from /events/stream — cursor below oldest retained seq",
          since,
          body,
        }),
      );
      report.markersWritten += 1;
    } else if (kind === "cursor_ahead_of_head") {
      markUnevaluated(report, "409 cursor_ahead_of_head — CROSSED CURSOR (a bug, not a transient)");
      report.control = { source: "http-409", ...(body ?? {}) };
      log.error?.(
        scrub(
          `${TAG} 409 cursor_ahead_of_head at since=${since} (feed head=${String(body?.head)}). ` +
            `A cursor ahead of head means the cursor was crossed — most likely a change_log.seq ` +
            `written into the event_log cursor. These are SEPARATE sequences. Not auto-clamped.`,
        ),
      );
      appender?.write(
        gapMarker({ reason: "cursor_ahead_of_head", detail: "409 from /events/stream", since, body }),
      );
      report.markersWritten += 1;
    } else {
      markUnevaluated(report, `409 with unrecognised error body: ${JSON.stringify(body)}`);
    }
    return report;
  }

  if (status === 401 || status === 403) {
    markUnevaluated(report, `auth failed (HTTP ${status}) — credential rejected`);
    log.error?.(scrub(`${TAG} HTTP ${status} from the feed — credential rejected. Nothing evaluated.`));
    return report;
  }

  if (status < 200 || status >= 300) {
    markUnevaluated(report, `unexpected HTTP ${status}`);
    return report;
  }

  const headSeq = parseHeadHeader(res.headers?.get?.("x-catalyst-event-head-seq"));
  if (headSeq === null) {
    // Without the stamped head there is NO coverage assertion possible. Contiguity
    // alone cannot see a short read, so reporting healthy here would be exactly
    // the defect this contract exists to prevent.
    markUnevaluated(report, "missing or malformed x-catalyst-event-head-seq — coverage unassertable");
    return report;
  }
  report.headSeq = headSeq;

  // ---- consume the stream in WIRE ORDER. Nothing is ever sorted. ----
  let prevSeq = null;
  let sawControl = false;

  try {
    for await (const line of ndjsonLines(res)) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        markUnevaluated(report, "unparseable NDJSON line");
        return report;
      }
      const cls = classifyLine(parsed);

      if (cls.kind === "invalid") {
        markUnevaluated(report, `invalid stream line: ${cls.reason}`);
        return report;
      }

      if (cls.kind === "control") {
        // Rule 3: the prefix is internally contiguous, so a naive gap check would
        // pass a SERVER-DECLARED INCOMPLETE SCAN. The run is not evaluable.
        sawControl = true;
        report.control = { source: "in-band", ...cls.record };
        markUnevaluated(
          report,
          `in-band control record ended the stream: ${JSON.stringify(cls.record)}`,
        );
        log.error?.(
          scrub(
            `${TAG} CONTROL RECORD received — the server declared this replay INCOMPLETE. ` +
              `Everything before it is real and was ingested; everything after is UNKNOWN. ` +
              `Run status = 2 (could not evaluate). record=${JSON.stringify(cls.record)}`,
          ),
        );
        appender?.write(
          gapMarker({
            reason: "control-record",
            detail: "in-band control line terminated the NDJSON stream",
            since,
            body: cls.record,
            lastSeq: report.lastSeq,
          }),
        );
        report.markersWritten += 1;
        break;
      }

      // ---- event line ----
      const rec = cls.record;
      const seq = strictSeq(rec.seq);
      if (seq === null) {
        markUnevaluated(report, `event line with a non-integer seq: ${JSON.stringify(rec.seq)}`);
        return report;
      }
      report.received += 1;
      if (report.firstSeq === null) report.firstSeq = seq;
      // INTEGRITY (separate from coverage): strict +1 adjacency, wire order, unsorted.
      if (prevSeq !== null && seq !== prevSeq + 1) {
        report.integrity.breaks.push({ prev: prevSeq, next: seq });
      }
      prevSeq = seq;
      report.lastSeq = seq;

      const src = typeof rec.source === "string" ? rec.source : "<missing>";
      const et = typeof rec.eventType === "string" ? rec.eventType : "<missing>";
      bump(report.bySource, src);
      bump(report.byType, `${src}:${et}`);

      const mapped = mapCloudEvent(rec, { teamsMap, tsMode, botUserIds });
      if (mapped.outcome === "invalid") {
        markUnevaluated(report, `unmappable-by-malformation at seq=${seq}: ${mapped.reason}`);
        return report;
      }
      if (mapped.outcome === "unmappable") {
        // NEVER silently skipped. An attributable, explicit gap marker.
        const marker = {
          marker: "unmappable-payload",
          ts: new Date().toISOString(),
          attributes: {
            "event.name": MARKER_UNMAPPABLE,
            "webhook.delivery.id": rec.deliveryId,
          },
          seq,
          deliveryId: rec.deliveryId,
          source: rec.source,
          eventType: rec.eventType,
          action: rec.action ?? null,
          payloadBytes: rec.payloadBytes ?? null,
          reason: "payloadOmitted",
          ...(rec.identity !== undefined ? { identity: rec.identity } : {}),
        };
        appender?.write(marker);
        report.markersWritten += 1;
        report.unmappable.push({
          seq,
          deliveryId: rec.deliveryId,
          source: rec.source,
          eventType: rec.eventType,
          ...(rec.identity !== undefined ? { identity: rec.identity } : {}),
        });
        // An elided payload is a real, targeted gap that needs a scoped reconcile.
        markProblem(report, `payloadOmitted at seq=${seq} (deliveryId=${rec.deliveryId})`);
        continue;
      }
      if (mapped.outcome === "bot-suppressed") {
        report.botSuppressed += 1;
        continue;
      }
      if (mapped.outcome === "ignored") {
        bump(report.ignoredByType, `${src}:${et}`);
        // Rule 9: classify against the DECLARED census, never against presence.
        // "the mapper ignored it" is only benign for a type we declared has no
        // mapper on either path.
        if (classifyProviderType(src, et) === "undeclared") bump(report.undeclaredTypes, `${src}:${et}`);
        continue;
      }

      if (needsPrCache(rec.source, rec.eventType, rec.payload)) report.prCacheDependent += 1;

      // Dedup on deliveryId (invariant 6) — the LOOKUP happens before the append,
      // but the MARK happens strictly after it. Marking first meant a write that
      // threw (EACCES / ENOSPC / a stale mount) left the id permanently poisoned
      // in the persisted ring: every later retry silently "deduped" a delivery
      // that was never written, and reported healthy. Write, then mark.
      if (seen.has(rec.deliveryId)) {
        report.deduped += 1;
        continue;
      }
      appender?.write(mapped.envelope);
      seen.add(rec.deliveryId);
      report.appended += 1;
      bump(report.appendedBySource, src);
      bump(report.appendedByType, `${src}:${et}`);
    }
  } catch (err) {
    markUnevaluated(report, `stream read failed: ${scrub(err?.message ?? String(err))}`);
    return report;
  }

  // ---- INTEGRITY verdict (independent of coverage) ----
  report.integrity.ok = report.integrity.breaks.length === 0;
  if (!report.integrity.ok) {
    markProblem(
      report,
      `internal gap(s)/inversion(s) in wire order: ${JSON.stringify(report.integrity.breaks)}`,
    );
  }

  // ---- COVERAGE verdict (invisible to any amount of contiguity checking) ----
  // Skipped when a control record already invalidated the run: the server told us
  // the replay is short, so "coverage failed" would be a redundant second verdict
  // on a run that is not evaluable at all.
  let provenHole = null;
  if (!sawControl) {
    const cov = report.coverage;
    if (report.received === 0) {
      if (since === headSeq) {
        cov.ok = true;
      } else if (since < headSeq) {
        cov.ok = false;
        cov.problems.push(`empty 200 while head is ahead (since=${since}, head=${headSeq})`);
      } else {
        cov.ok = false;
        cov.problems.push(`empty 200 with since(${since}) > head(${headSeq}) — crossed cursor`);
      }
    } else {
      if (report.firstSeq !== since + 1) {
        cov.ok = false;
        cov.problems.push(`first seq ${report.firstSeq} != since+1 (${since + 1}) — replay starts late`);
        // A PROVEN hole: seqs since+1..firstSeq-1 were never delivered and never
        // will be if we advance past them. Recorded here so the cursor policy and
        // the durable marker below both key on the same fact.
        provenHole = {
          reason: "coverage-late-start",
          missingFrom: since + 1,
          missingTo: report.firstSeq - 1,
        };
      }
      if (report.lastSeq < headSeq) {
        cov.ok = false;
        cov.problems.push(`last seq ${report.lastSeq} < head ${headSeq} — SHORT READ (clean EOF, no control record)`);
      }
      if (cov.ok === null) cov.ok = true;
      if (report.lastSeq > headSeq) {
        // Not a fault: the feed advanced while we read. Recorded so a
        // cross-consumer sample taken at the same cursor stays comparable.
        cov.advancedDuringRead = report.lastSeq - headSeq;
      }
    }
    if (cov.ok === false) markProblem(report, `coverage: ${cov.problems.join("; ")}`);
    if (provenHole !== null) {
      // DURABLE evidence. An in-memory report dies with the process; the poll loop
      // never exits, so the exit code carrying this finding is never observed by
      // anything. The marker is what parity-harness's FEED_GAP_DECLARED blocker
      // consumes, so a later parity run over this window goes non-evaluable
      // instead of confidently green over a hole.
      appender?.write(
        gapMarker({
          reason: provenHole.reason,
          detail:
            `coverage assertion PROVED a hole: seqs ${provenHole.missingFrom}..${provenHole.missingTo} ` +
            `were never delivered (first seq ${report.firstSeq} != since+1). The cursor is NOT advanced past them.`,
          since,
          body: {
            missingFrom: provenHole.missingFrom,
            missingTo: provenHole.missingTo,
            firstSeq: report.firstSeq,
            lastSeq: report.lastSeq,
            headSeq: report.headSeq,
            problems: cov.problems,
          },
          lastSeq: report.lastSeq,
        }),
      );
      report.markersWritten += 1;
      log.error?.(
        scrub(
          `${TAG} COVERAGE HOLE at since=${since}: seqs ${provenHole.missingFrom}..${provenHole.missingTo} ` +
            `were never delivered. Cursor left UNCHANGED and a ${MARKER_FEED_GAP} marker written. ` +
            `Reconcile that range, then re-point deliberately with --since.`,
        ),
      );
    }
  }

  // ---- per-source non-zero assertion (rule 5), opt-in ----
  // Reads the APPENDED census, never the wire census: a source whose records all
  // arrived and were then declined by the mapper contributed nothing to the shadow
  // log, and "one lucky wire record" must not satisfy a non-zero assertion.
  for (const s of requireSources) {
    if ((report.appendedBySource[s] ?? 0) === 0) {
      markProblem(
        report,
        `required source "${s}" appended ZERO envelopes in this window ` +
          `(wire records received: ${report.bySource[s] ?? 0})`,
      );
    }
  }

  // ---- productive-output assertions (rule 9: counts of what was APPENDED) ----
  // An UNDECLARED provider type is a cloud-side schema/casing change, not a known
  // drop: "Comment" -> "comment" makes 100% of Linear events `ignored` while every
  // wire-level counter stays healthy.
  for (const [key, n] of Object.entries(report.undeclaredTypes)) {
    markProblem(
      report,
      `undeclared provider type ${key}: ${n} record(s) produced NO envelope. It is neither ` +
        `declared-mappable nor declared-unmappable — classify it (DECLARED_*_TYPES) before trusting a green run`,
    );
  }
  // A type the mapper DECLARES it handles that produced records and zero envelopes
  // is a mapper/schema regression (the "Comment payload nests under `comment`"
  // drift), not coverage data.
  for (const [key, n] of Object.entries(report.ignoredByType)) {
    const cut = key.indexOf(":");
    const s = key.slice(0, cut);
    const t = key.slice(cut + 1);
    if (classifyProviderType(s, t) !== "declared-mappable") continue;
    if ((report.appendedByType[key] ?? 0) > 0) continue;
    markProblem(
      report,
      `${key}: ${n} record(s) declined by the mapper and ZERO envelopes appended for that type — ` +
        `a declared-mappable type produced nothing`,
    );
  }

  if (sawControl) {
    // INVARIANT 7 — underflow means RECONCILE, not resume. Advancing the cursor
    // past a server-declared incomplete scan is precisely "assume continuity
    // across a gap": a later restart would silently resume beyond the hole and
    // never mention it again. The cursor stays exactly where it was; the operator
    // must re-point it deliberately (--since) after reconciling.
    report.cursorAdvancedTo = null;
    if (report.firstSeq !== null && report.firstSeq !== since + 1) {
      report.unevaluated.push(
        `replay also started late: first seq ${report.firstSeq} != since+1 (${since + 1}) — ` +
          `seqs ${since + 1}..${report.firstSeq - 1} were never delivered`,
      );
    }
    return report;
  }

  if (provenHole !== null) {
    // Same rule as the control record: NEVER advance past a hole we have PROVEN.
    // Advancing would burn seqs missingFrom..missingTo forever and every later
    // pass would report healthy. The operator reconciles and re-points --since.
    report.cursorAdvancedTo = null;
    return report;
  }

  // NOTE on the OTHER coverage failure, the short read (lastSeq < head): advancing
  // to lastSeq skips NOTHING — the undelivered tail is still ahead of the cursor
  // and is re-fetched on the next pass — so it stays a loud exit-1 problem without
  // a durable gap marker. Writing one would make routine catch-up paging
  // permanently non-evaluable for the harness, which is its own false signal.
  report.cursorAdvancedTo = report.lastSeq === null ? since : report.lastSeq;
  return report;
}

function gapMarker({ reason, detail, since, body, lastSeq = null }) {
  return {
    marker: "feed-gap",
    ts: new Date().toISOString(),
    attributes: { "event.name": MARKER_FEED_GAP },
    reason,
    detail,
    since,
    lastSeq,
    body: body ?? null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Flags that consume the NEXT token as their value. */
export const VALUE_FLAGS = new Set([
  "--since", "--base-url", "--interval-ms", "--poll-ms", "--ts-mode",
  "--require-source", "--max-consecutive-failures", "--max-passes",
]);

export function parseArgv(argv) {
  const out = {
    once: false,
    json: false,
    selfTest: false,
    since: undefined,
    sinceRaw: undefined,
    baseUrl: undefined,
    pollMs: undefined,
    tsMode: "receivedAt",
    requireSources: [],
    maxConsecutiveFailures: undefined,
    errors: [],
    help: false,
  };
  // Rule 6, reached through the door a wrapper script opens: a value-taking flag
  // whose value was eaten (`--since $SEQ` with SEQ unset, or the flag in final
  // position) MUST be an error. Falling through to `undefined` silently discarded
  // the flag and resumed from the persisted cursor / the default base URL / an
  // empty --require-source, and then reported healthy about a range nobody asked
  // for. Mirrors parity-harness.mjs parseArgs.
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || (typeof v === "string" && v.startsWith("--"))) {
      out.errors.push(`${flag} requires a value (got ${v === undefined ? "end of arguments" : JSON.stringify(v)})`);
      return null;
    }
    return v;
  };
  const takeInline = (flag, a, prefix) => {
    const v = a.slice(prefix.length);
    if (v.length === 0) {
      out.errors.push(`${flag} requires a non-empty value`);
      return null;
    }
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--once") out.once = true;
    else if (a === "--json") out.json = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = takeValue(a, i);
      i += 1;
      if (v === null) continue;
      if (a === "--since") out.sinceRaw = v;
      else if (a === "--base-url") out.baseUrlRaw = v;
      else if (a === "--interval-ms" || a === "--poll-ms") out.pollRaw = v;
      else if (a === "--ts-mode") out.tsModeRaw = v;
      else if (a === "--require-source") out.requireRaw = v;
      else if (a === "--max-consecutive-failures") out.maxFailRaw = v;
      else if (a === "--max-passes") out.maxPassesRaw = v;
    } else if (a.startsWith("--since=")) {
      const v = takeInline("--since", a, "--since=");
      if (v !== null) out.sinceRaw = v;
    } else if (a.startsWith("--base-url=")) {
      const v = takeInline("--base-url", a, "--base-url=");
      if (v !== null) out.baseUrlRaw = v;
    } else if (a.startsWith("--interval-ms=")) {
      const v = takeInline("--interval-ms", a, "--interval-ms=");
      if (v !== null) out.pollRaw = v;
    } else if (a.startsWith("--ts-mode=")) {
      const v = takeInline("--ts-mode", a, "--ts-mode=");
      if (v !== null) out.tsModeRaw = v;
    } else if (a.startsWith("--require-source=")) {
      const v = takeInline("--require-source", a, "--require-source=");
      if (v !== null) out.requireRaw = v;
    } else if (a.startsWith("--max-consecutive-failures=")) {
      const v = takeInline("--max-consecutive-failures", a, "--max-consecutive-failures=");
      if (v !== null) out.maxFailRaw = v;
    } else if (a.startsWith("--max-passes=")) {
      const v = takeInline("--max-passes", a, "--max-passes=");
      if (v !== null) out.maxPassesRaw = v;
    } else out.errors.push(`unknown argument: ${a}`);
  }

  if (out.baseUrlRaw !== undefined) {
    if (!/^https?:\/\/[^\s]+$/.test(out.baseUrlRaw)) {
      out.errors.push(`--base-url must be an http(s) URL, got ${JSON.stringify(out.baseUrlRaw)}`);
    } else out.baseUrl = out.baseUrlRaw;
  }
  if (out.tsModeRaw !== undefined) out.tsMode = out.tsModeRaw;

  // Rule 6: reject, never repair.
  if (out.sinceRaw !== undefined) {
    const n = parseSinceArg(out.sinceRaw);
    if (n === null) out.errors.push(`--since must be a non-negative integer, got ${JSON.stringify(out.sinceRaw)}`);
    else out.since = n;
  }
  if (out.pollRaw !== undefined) {
    const n = parseSinceArg(out.pollRaw);
    if (n === null || n === 0) out.errors.push(`--interval-ms must be a positive integer, got ${JSON.stringify(out.pollRaw)}`);
    else out.pollMs = n;
  }
  if (out.maxFailRaw !== undefined) {
    const n = parseSinceArg(out.maxFailRaw);
    if (n === null || n === 0) out.errors.push(`--max-consecutive-failures must be a positive integer`);
    else out.maxConsecutiveFailures = n;
  }
  if (out.maxPassesRaw !== undefined) {
    const n = parseSinceArg(out.maxPassesRaw);
    if (n === null || n === 0) out.errors.push(`--max-passes must be a positive integer`);
    else out.maxPasses = n;
  }
  if (out.requireRaw !== undefined) {
    const parts = String(out.requireRaw).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    // An empty list silently turns the ONLY dead-source detector into a no-op.
    // `--require-source ""` / `--require-source ,` must be an error, not a waiver.
    if (parts.length === 0) {
      out.errors.push(`--require-source parses to ZERO sources (${JSON.stringify(out.requireRaw)}) — that would disable the non-zero assertion`);
    }
    for (const p of parts) {
      if (p !== "github" && p !== "linear") out.errors.push(`--require-source: unknown source "${p}"`);
    }
    out.requireSources = parts;
  }
  if (out.tsMode !== "receivedAt" && out.tsMode !== "now") {
    out.errors.push(`--ts-mode must be receivedAt|now, got ${JSON.stringify(out.tsMode)}`);
  }
  return out;
}

export const USAGE = `${TAG} CTL-1534 — shadow consumer of the catalyst-cloud event feed.

  bun cloud-event-consumer.mjs [--once] [--json] [--since N] [--base-url URL]
                               [--interval-ms N] [--ts-mode receivedAt|now]
                               [--require-source github,linear]
                               [--max-consecutive-failures N] [--max-passes N]
  bun cloud-event-consumer.mjs --self-test     # credential-free, offline negative control

EXIT: 0 evaluated-healthy · 1 evaluated-problem · 2 COULD NOT EVALUATE.
Writes ONLY to <CATALYST_DIR>/${SHADOW_DIR_NAME}/YYYY-MM.jsonl — never the live event log.
`;

export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => new Date(),
  } = deps;

  const args = parseArgv(argv);
  if (args.help) {
    stdout(USAGE);
    return EXIT_HEALTHY;
  }
  if (args.errors.length > 0) {
    for (const e of args.errors) stderr(`${TAG} ${e}\n`);
    stderr(`${TAG} refusing to run on un-normalised input (exit 2 = could not evaluate)\n`);
    return EXIT_UNEVALUATED;
  }

  if (args.selfTest) return runSelfTest({ stdout, stderr });

  const catalystDir = deps.catalystDir ?? defaultCatalystDir(env);

  const { token, source: tokenSource } = deps.tokenOverride
    ? { token: deps.tokenOverride, source: "injected" }
    : readCloudToken({ env });
  const scrub = makeScrubber(token);
  const log = deps.log ?? {
    info: (m) => stderr(`${scrub(m)}\n`),
    warn: (m) => stderr(`${scrub(m)}\n`),
    error: (m) => stderr(`${scrub(m)}\n`),
  };

  if (token.length === 0) {
    log.error(`${TAG} no CATALYST_CLOUD_TOKEN resolvable (env or ${defaultCloudSyncEnvPath(env)}) — nothing evaluated`);
    return EXIT_UNEVALUATED;
  }
  log.info(`${TAG} token resolved from ${tokenSource} (value never logged)`);

  const { state, ok: stateOk, reason: stateReason } = readState(catalystDir);
  if (!stateOk) {
    log.error(`${TAG} cursor state file is unusable (${stateReason}) at ${statePath(catalystDir)} — refusing to guess a cursor`);
    return EXIT_UNEVALUATED;
  }

  let cursor = args.since !== undefined ? args.since : state.cursor;
  if (cursor === null) {
    log.error(
      `${TAG} no persisted cursor and no --since. Refusing to default to 0: once retention ` +
        `evicts, since=0 409s forever. Pass --since <seq> explicitly for the first run.`,
    );
    return EXIT_UNEVALUATED;
  }

  let appender;
  try {
    appender = createShadowAppender(catalystDir, { now });
  } catch (err) {
    log.error(`${TAG} refusing to start: ${scrub(err?.message ?? String(err))}`);
    return EXIT_UNEVALUATED;
  }
  log.info(`${TAG} shadow log: ${appender.dir} (the live event log is NEVER written)`);

  const seen = new Set(state.seenDeliveryIds);
  const teamsMap = new Map(
    (deps.linearTeams ?? safeReadClusterProjects(log, scrub)).map((t) => [t.key, t.vcsRepo]),
  );
  const botUserIds = deps.botUserIds ?? safeReadBotIds(log, scrub);
  // Both of these silently degrade the shadow envelope if they resolve empty
  // (no vcs.repository.name on Linear events; no bot suppression -> shadow-only
  // rows in the parity join). Say so out loud rather than let the harness
  // discover it as an unexplained diff.
  log.info(
    `${TAG} config: ${teamsMap.size} team->repo entries, ${botUserIds.size} bot actor id(s)` +
      (teamsMap.size === 0 ? " — WARN: no roster, Linear envelopes will lack vcs.repository.name" : "") +
      (botUserIds.size === 0 ? " — WARN: no bot ids, bot-authored issue events will NOT be suppressed" : ""),
  );

  const baseUrl = args.baseUrl ?? env.CATALYST_CLOUD_EVENTS_BASE_URL ?? DEFAULT_BASE_URL;
  // The env path is validated EXACTLY as the flag path is. Repairing a malformed
  // value into the default meant the operator set a cadence, the tool discarded
  // it, and every healthy report afterwards described a cadence nobody configured
  // — and "0" survived `??` into an unthrottled poll loop the flag form rejects.
  let pollMs = args.pollMs ?? DEFAULT_POLL_MS;
  if (args.pollMs === undefined && typeof env.CATALYST_CLOUD_EVENT_POLL_MS === "string" && env.CATALYST_CLOUD_EVENT_POLL_MS.length > 0) {
    const n = parseSinceArg(env.CATALYST_CLOUD_EVENT_POLL_MS);
    if (n === null || n === 0) {
      log.error(`${TAG} CATALYST_CLOUD_EVENT_POLL_MS must be a positive integer, got ${JSON.stringify(env.CATALYST_CLOUD_EVENT_POLL_MS)} — refusing to silently substitute the default`);
      return EXIT_UNEVALUATED;
    }
    pollMs = n;
  }
  const maxFail = args.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  let worst = EXIT_HEALTHY;
  let consecutiveFailures = 0;
  const reports = [];

  for (;;) {
    const report = await runOnce({
      fetchImpl,
      baseUrl,
      token,
      since: cursor,
      appender,
      teamsMap,
      botUserIds,
      tsMode: args.tsMode,
      seen,
      log,
      scrub,
      requireSources: args.requireSources,
    });
    reports.push(report);
    // 2 dominates 1 dominates 0 — worst-observed, never downgraded.
    if (report.status === EXIT_UNEVALUATED) worst = EXIT_UNEVALUATED;
    else if (report.status === EXIT_PROBLEM && worst !== EXIT_UNEVALUATED) worst = EXIT_PROBLEM;

    // Persist whatever we genuinely ingested, even on a bad pass — those events
    // were really delivered. The cursor is NEVER advanced past what we received,
    // and is left completely untouched when nothing was received.
    const cursorBefore = cursor;
    if (report.cursorAdvancedTo !== null && report.cursorAdvancedTo !== cursor) {
      cursor = report.cursorAdvancedTo;
    }
    const madeProgress = cursor !== cursorBefore;
    try {
      writeState(catalystDir, { cursor, seenDeliveryIds: Array.from(seen) });
    } catch (err) {
      log.error(`${TAG} cursor persist FAILED: ${scrub(err?.message ?? String(err))}`);
      worst = EXIT_UNEVALUATED;
      break;
    }

    if (!args.json) log.info(`${TAG} ${summarize(report)}`);

    if (args.once) break;

    // Hard upper bound on passes. A poll loop with no bound can HANG instead of
    // failing when a status-classification bug makes every pass look retryable —
    // and a hang is not a red, it is an absence of a verdict.
    if (args.maxPasses !== undefined && reports.length >= args.maxPasses) {
      log.warn?.(`${TAG} reached --max-passes ${args.maxPasses} — stopping`);
      break;
    }

    if (isTerminal(report)) {
      log.error(`${TAG} terminal condition — stopping the poll loop. ${report.unevaluated.join("; ")}`);
      break;
    }
    // A non-healthy pass that ALSO made no progress is not a transient: the same
    // cursor will produce the same verdict forever. Bounding only EXIT_UNEVALUATED
    // let a permanent EXIT_PROBLEM (a proven coverage hole, an empty 200 while head
    // is ahead) spin at one cursor indefinitely — and a process that never exits
    // never reports its exit code, so "still running" read as healthy.
    if (report.status !== EXIT_HEALTHY && !madeProgress) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFail) {
        log.error(
          `${TAG} ${consecutiveFailures} consecutive non-healthy passes with NO cursor progress ` +
            `(cursor stuck at ${cursor}) — stopping rather than spinning. worst status so far = ${worst}`,
        );
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
    await sleep(pollMs);
  }

  if (args.json) {
    stdout(JSON.stringify({ exit: worst, reports }, null, 2) + "\n");
  } else {
    stdout(`${TAG} exit=${worst} (0=healthy 1=problem 2=COULD-NOT-EVALUATE) passes=${reports.length}\n`);
  }
  return worst;
}

/** Terminal = a condition that cannot resolve by retrying the same cursor. */
function isTerminal(report) {
  if (report.control !== null) return true;
  return report.unevaluated.some(
    (r) =>
      r.startsWith("409 ") ||
      r.startsWith("auth failed") ||
      r.startsWith("since is not") ||
      r.startsWith("missing or malformed x-catalyst-event-head-seq"),
  );
}

function summarize(r) {
  const parts = [
    `since=${r.since}`,
    `head=${r.headSeq ?? "?"}`,
    `recv=${r.received}`,
    `appended=${r.appended}`,
    `dedup=${r.deduped}`,
    `coverage=${r.coverage.ok === null ? "n/a" : r.coverage.ok ? "ok" : "FAIL"}`,
    `integrity=${r.integrity.ok === null ? "n/a" : r.integrity.ok ? "ok" : "FAIL"}`,
    `unmappable=${r.unmappable.length}`,
    `markers=${r.markersWritten}`,
    `status=${r.status}`,
  ];
  // Printed UNCONDITIONALLY, with both sources seeded at zero: "linear delivered
  // nothing" must not look identical to "linear was not part of this window".
  const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(",") || "-";
  parts.push(`bySource=${fmt(r.bySource)}`);
  parts.push(`appendedBySource=${fmt(r.appendedBySource)}`);
  parts.push(`byType=${fmt(r.byType)}`);
  parts.push(`ignoredByType=${fmt(r.ignoredByType)}`);
  if (r.problems.length) parts.push(`problems=[${r.problems.join(" | ")}]`);
  if (r.unevaluated.length) parts.push(`unevaluated=[${r.unevaluated.join(" | ")}]`);
  return parts.join(" ");
}

function safeReadClusterProjects(log, scrub) {
  try {
    return readClusterProjects();
  } catch (err) {
    log.warn?.(`${TAG} team roster unreadable (${scrub(err?.message ?? String(err))}) — vcs.repository.name will be absent on Linear envelopes`);
    return [];
  }
}

function safeReadBotIds(log, scrub) {
  try {
    return readLinearBotUserIds();
  } catch (err) {
    log.warn?.(`${TAG} bot-actor ids unreadable (${scrub(err?.message ?? String(err))}) — bot-authored issue events will NOT be suppressed`);
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — credential-free, offline, CI-runnable, and OBSERVED red.
//
// Rule 8: the load-bearing control must run where it is most useful (a clean
// checkout, secret-free CI). It uses an in-memory fetch and an in-memory
// appender: no token, no network, no filesystem writes.
// ---------------------------------------------------------------------------

function fakeResponse({ status = 200, head = null, lines = [], body = null }) {
  const headers = new Map();
  if (head !== null) headers.set("x-catalyst-event-head-seq", String(head));
  return {
    status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    text: async () => (body !== null ? JSON.stringify(body) : lines.map((l) => JSON.stringify(l)).join("\n") + "\n"),
  };
}

export function ghEvent(seq, deliveryId, extra = {}) {
  return {
    accountId: "tenant-0",
    seq,
    deliveryId,
    source: "github",
    eventType: "pull_request",
    action: "opened",
    receivedAt: "2026-07-26T20:00:00.000Z",
    payload: {
      action: "opened",
      repository: { full_name: "coalesce-labs/catalyst" },
      pull_request: { number: 2751, head: { ref: "ryan/x", sha: "abc123" } },
    },
    ...extra,
  };
}

export function linearEvent(seq, deliveryId, extra = {}) {
  return {
    accountId: "tenant-0",
    seq,
    deliveryId,
    source: "linear",
    eventType: "Comment",
    action: "create",
    receivedAt: "2026-07-26T20:00:00.000Z",
    payload: {
      type: "Comment",
      action: "create",
      data: { id: "cmt-1", body: "hello", issue: { identifier: "CTL-1534" } },
    },
    ...extra,
  };
}

function memAppender() {
  const records = [];
  return { records, write: (r) => records.push(r), dir: "<memory>" };
}

const SELF_TEST_CASES = [
  {
    name: "healthy: full replay, contiguous, spans since+1..head",
    expect: EXIT_HEALTHY,
    build: () => ({ since: 0, res: fakeResponse({ head: 3, lines: [ghEvent(1, "d1"), linearEvent(2, "d2"), ghEvent(3, "d3")] }) }),
  },
  {
    name: "healthy: empty 200 with cursor exactly at head",
    expect: EXIT_HEALTHY,
    build: () => ({ since: 7, res: fakeResponse({ head: 7, lines: [] }) }),
  },
  {
    name: "RED coverage: empty 200 while head is AHEAD (internally contiguous, no control record)",
    expect: EXIT_PROBLEM,
    build: () => ({ since: 3, res: fakeResponse({ head: 9, lines: [] }) }),
  },
  {
    name: "RED coverage: replay STARTS LATE (first != since+1)",
    expect: EXIT_PROBLEM,
    build: () => ({ since: 0, res: fakeResponse({ head: 3, lines: [ghEvent(2, "d2"), ghEvent(3, "d3")] }) }),
  },
  {
    name: "RED coverage: SHORT READ, clean EOF before head",
    expect: EXIT_PROBLEM,
    build: () => ({ since: 0, res: fakeResponse({ head: 9, lines: [ghEvent(1, "d1"), ghEvent(2, "d2")] }) }),
  },
  {
    name: "RED integrity: internal gap 1,3",
    expect: EXIT_PROBLEM,
    build: () => ({ since: 0, res: fakeResponse({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(3, "d3")] }) }),
  },
  {
    name: "RED integrity: wire-order inversion 1,3,2 is NOT sorted away",
    expect: EXIT_PROBLEM,
    build: () => ({ since: 0, res: fakeResponse({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(3, "d3"), ghEvent(2, "d2")] }) }),
  },
  {
    name: "UNEVALUATED: in-band control record terminates a contiguous prefix",
    expect: EXIT_UNEVALUATED,
    build: () => ({
      since: 0,
      res: fakeResponse({ head: 9, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), { error: "cursor_underflow", resync: true }] }),
    }),
  },
  {
    name: "UNEVALUATED: 409 cursor_underflow",
    expect: EXIT_UNEVALUATED,
    build: () => ({ since: 1, res: fakeResponse({ status: 409, body: { error: "cursor_underflow", resync: true } }) }),
  },
  {
    name: "UNEVALUATED: 409 cursor_ahead_of_head",
    expect: EXIT_UNEVALUATED,
    build: () => ({ since: 999999999, res: fakeResponse({ status: 409, body: { error: "cursor_ahead_of_head", resync: true, head: 113 } }) }),
  },
  {
    name: "UNEVALUATED: missing x-catalyst-event-head-seq (coverage unassertable)",
    expect: EXIT_UNEVALUATED,
    build: () => ({ since: 0, res: fakeResponse({ head: null, lines: [ghEvent(1, "d1")] }) }),
  },
  {
    name: "UNEVALUATED: HTTP 401 (credential rejected)",
    expect: EXIT_UNEVALUATED,
    build: () => ({ since: 0, res: fakeResponse({ status: 401 }) }),
  },
  {
    name: "UNEVALUATED: fetch throws (probe failed -> never 'healthy')",
    expect: EXIT_UNEVALUATED,
    build: () => ({ since: 0, throws: new Error("ECONNREFUSED") }),
  },
  {
    name: "UNEVALUATED: seq arrives as a STRING (evidence not coerced)",
    expect: EXIT_UNEVALUATED,
    build: () => ({ since: 0, res: fakeResponse({ head: 1, lines: [{ ...ghEvent(1, "d1"), seq: "1" }] }) }),
  },
  {
    name: "PROBLEM: payloadOmitted produces an attributable gap marker, never a silent skip",
    expect: EXIT_PROBLEM,
    build: () => ({
      since: 0,
      res: fakeResponse({
        head: 1,
        lines: [
          {
            accountId: "tenant-0", seq: 1, deliveryId: "big-1", source: "linear",
            eventType: "Comment", action: "create", receivedAt: "2026-07-26T20:00:00.000Z",
            payload: null, payloadOmitted: true, payloadBytes: 120000,
            identity: { id: "iss-1", identifier: "CTL-1534" },
          },
        ],
      }),
    }),
  },
  {
    name: "HEALTHY: payloadOmitted ABSENT on a normal event (truthy test, not key-presence)",
    expect: EXIT_HEALTHY,
    build: () => ({ since: 0, res: fakeResponse({ head: 1, lines: [ghEvent(1, "d1")] }) }),
  },
  {
    name: "RED per-source: --require-source linear with zero linear events",
    expect: EXIT_PROBLEM,
    requireSources: ["linear"],
    build: () => ({ since: 0, res: fakeResponse({ head: 1, lines: [ghEvent(1, "d1")] }) }),
  },
  {
    name: "HEALTHY: payloadOmitted:false still maps (key-presence would break this)",
    expect: EXIT_HEALTHY,
    build: () => ({ since: 0, res: fakeResponse({ head: 1, lines: [ghEvent(1, "d1", { payloadOmitted: false })] }) }),
  },
  {
    name: "DEDUP: a repeated deliveryId in one stream is appended exactly once",
    expect: EXIT_HEALTHY,
    assertReport: (r) => r.appended === 1 && r.deduped === 1,
    build: () => ({ since: 0, res: fakeResponse({ head: 2, lines: [ghEvent(1, "dup"), ghEvent(2, "dup")] }) }),
  },
  {
    // Rule 8 applied to the PRODUCER/HARNESS contract: the ordering attribute the
    // parity harness keys on must be present on a real envelope, with the wire seq.
    name: "CONTRACT: every appended envelope carries the cloud seq the harness reads",
    expect: EXIT_HEALTHY,
    assertReport: (r, app) => {
      const envelopes = app.records.filter((x) => x.attributes?.["event.name"]?.includes("."));
      if (envelopes.length !== 2) return false;
      return (
        envelopes[0].attributes[SEQ_ATTR] === 1 &&
        envelopes[1].attributes[SEQ_ATTR] === 2 &&
        // and BOTH sources actually produced an envelope — a positive control that
        // never inspects the output cannot see a per-source mapping regression
        envelopes.some((e) => e.attributes["event.name"].startsWith("github.")) &&
        envelopes.some((e) => e.attributes["event.name"].startsWith("linear."))
      );
    },
    build: () => ({ since: 0, res: fakeResponse({ head: 2, lines: [ghEvent(1, "d1"), linearEvent(2, "d2")] }) }),
  },
  {
    name: "PROBLEM: a PROVEN coverage hole writes a durable gap marker and does NOT advance the cursor",
    expect: EXIT_PROBLEM,
    assertReport: (r, app) => {
      const gaps = app.records.filter((x) => x.attributes?.["event.name"] === MARKER_FEED_GAP);
      return (
        r.cursorAdvancedTo === null &&
        gaps.length === 1 &&
        gaps[0].reason === "coverage-late-start" &&
        gaps[0].body?.missingFrom === 1 &&
        gaps[0].body?.missingTo === 8
      );
    },
    build: () => ({ since: 0, res: fakeResponse({ head: 10, lines: [ghEvent(9, "d9"), ghEvent(10, "d10")] }) }),
  },
  {
    name: "DEDUP ORDERING: a failed append never marks the delivery seen (no permanent silent skip)",
    expect: EXIT_UNEVALUATED,
    direct: async () => {
      const seen = new Set();
      const report = await runOnce({
        fetchImpl: async () => fakeResponse({ head: 1, lines: [ghEvent(1, "d1")] }),
        token: "",
        since: 0,
        appender: { write: () => { throw new Error("EACCES"); }, dir: "<broken>" },
        seen,
        log: { info() {}, warn() {}, error() {} },
      });
      // The run must be unevaluated AND the id must NOT be poisoned into the ring.
      return report.status === EXIT_UNEVALUATED && !seen.has("d1") ? EXIT_UNEVALUATED : EXIT_HEALTHY;
    },
  },
  {
    name: "RED per-source: --require-source counts APPENDED envelopes, not wire records",
    expect: EXIT_PROBLEM,
    requireSources: ["linear"],
    build: () => ({
      since: 0,
      res: fakeResponse({
        head: 1,
        // A declared-unmappable Linear provider type: it arrives (bySource.linear = 1)
        // but produces no envelope. Counting the wire record satisfied the assertion.
        lines: [{ ...linearEvent(1, "att-1"), eventType: "Attachment", payload: { type: "Attachment", action: "create", data: {} } }],
      }),
    }),
  },
  {
    name: "RED mapper regression: an UNDECLARED provider type (casing drift) is a problem, not coverage data",
    expect: EXIT_PROBLEM,
    build: () => ({
      since: 0,
      res: fakeResponse({ head: 1, lines: [{ ...linearEvent(1, "c1"), eventType: "comment" }] }),
    }),
  },
  {
    name: "RED mapper regression: a DECLARED-mappable type that appended nothing is a problem",
    expect: EXIT_PROBLEM,
    build: () => ({
      since: 0,
      // "Comment" IS declared-mappable; the payload nests under `comment` instead of
      // `data` (the recorded Linear schema drift), so every record is ignored.
      res: fakeResponse({
        head: 2,
        lines: [
          { ...linearEvent(1, "c1"), payload: { type: "Comment", action: "create", comment: { id: "x" } } },
          { ...linearEvent(2, "c2"), payload: { type: "Comment", action: "create", comment: { id: "y" } } },
        ],
      }),
    }),
  },
  {
    name: "HEALTHY: a DECLARED-unmappable provider type (workflow_job) is expected-zero, not a problem",
    expect: EXIT_HEALTHY,
    build: () => ({
      since: 0,
      res: fakeResponse({
        head: 2,
        lines: [
          ghEvent(1, "wj-1", { eventType: "workflow_job", payload: { repository: { full_name: "a/b" } } }),
          ghEvent(2, "d2"),
        ],
      }),
    }),
  },
  {
    name: "UNEVALUATED: a value-taking flag with its value EATEN is rejected, never silently dropped",
    expect: EXIT_UNEVALUATED,
    direct: async () => {
      const dangling = [...VALUE_FLAGS].every((f) => parseArgv(["--once", f]).errors.length > 0);
      const empties = ["--since=", "--require-source=", "--base-url=", "--ts-mode=", "--interval-ms="].every(
        (f) => parseArgv(["--once", f]).errors.length > 0,
      );
      const flagShaped = parseArgv(["--since", "--json"]).errors.length > 0;
      const emptyList = parseArgv(["--require-source", ","]).errors.length > 0;
      const good = parseArgv(["--once", "--since", "42", "--require-source", "github"]).errors.length === 0;
      return dangling && empties && flagShaped && emptyList && good ? EXIT_UNEVALUATED : EXIT_HEALTHY;
    },
  },
  {
    name: "UNEVALUATED: --since banana / 1e3 / -1 / ' 5' are all REJECTED, never coerced",
    expect: EXIT_UNEVALUATED,
    direct: async () => {
      const bad = ["banana", "1e3", "-1", " 5", "1.0", "0x10", "+3"];
      const allRejected = bad.every((v) => parseArgv(["--since", v]).errors.length > 0);
      const goodAccepted = parseArgv(["--since", "42"]).errors.length === 0;
      return allRejected && goodAccepted ? EXIT_UNEVALUATED : EXIT_HEALTHY;
    },
  },
  {
    name: "UNEVALUATED: the shadow dir constant is NOT the live events dir name",
    expect: EXIT_UNEVALUATED,
    direct: async () =>
      SHADOW_DIR_NAME !== LIVE_DIR_NAME && resolveShadowDir("/tmp/fake-catalyst").endsWith(SHADOW_DIR_NAME)
        ? EXIT_UNEVALUATED
        : EXIT_HEALTHY,
  },
  {
    name: "UNEVALUATED: shadow dir can NEVER resolve onto the live events dir",
    expect: EXIT_UNEVALUATED,
    direct: async () => {
      try {
        resolveShadowDir("/tmp/fake-catalyst/events");
        return EXIT_HEALTHY; // detector FAILED to fire
      } catch {
        return EXIT_UNEVALUATED;
      }
    },
  },
];

export async function runSelfTest({ stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  const rows = [];
  let allOk = true;
  for (const c of SELF_TEST_CASES) {
    let got;
    try {
      if (c.direct) {
        got = await c.direct();
      } else {
        const { since, res, throws } = c.build();
        const app = memAppender();
        const report = await runOnce({
          fetchImpl: async () => {
            if (throws) throw throws;
            return res;
          },
          token: "", // credential-free by construction
          since,
          appender: app,
          seen: new Set(),
          log: { info() {}, warn() {}, error() {} },
          requireSources: c.requireSources ?? [],
        });
        got = report.status;
        // Some detectors assert on the REPORT and on what was actually WRITTEN, not
        // just the exit code — a status check alone cannot see a removed dedup
        // (still exit 0, silently double-appending), a missing seq stamp, or a
        // whole source that produced no envelope.
        if (c.assertReport && !c.assertReport(report, app)) {
          got = `report-assertion-failed(status=${report.status})`;
        }
      }
    } catch (err) {
      got = `THREW: ${err?.message ?? String(err)}`;
    }
    const ok = got === c.expect;
    if (!ok) allOk = false;
    rows.push({ name: c.name, expect: c.expect, got, ok });
  }
  const red = rows.filter((r) => r.expect !== EXIT_HEALTHY).length;
  stdout(`${TAG} --self-test (credential-free, offline)\n`);
  for (const r of rows) {
    stdout(`  ${r.ok ? "PASS" : "FAIL"}  expect=${r.expect} got=${r.got}  ${r.name}\n`);
  }
  stdout(`${TAG} ${rows.length} cases; ${red} detectors expected RED; ${rows.filter((r) => r.ok).length} correct\n`);
  if (!allOk) {
    stderr(`${TAG} SELF-TEST FAILED — a detector did not fire. The harness cannot be trusted.\n`);
    return EXIT_PROBLEM;
  }
  return EXIT_HEALTHY;
}

// ---------------------------------------------------------------------------
// Direct invocation
// ---------------------------------------------------------------------------

const _invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("cloud-event-consumer.mjs");

if (_invokedDirectly) {
  const code = await main();
  process.exit(code);
}
