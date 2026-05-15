import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { inProgressGlyph, sourceIcon, prPrefix } from "./nerd-font.ts";

// CTL-419: extract the short form of a wake recipient session ID.
// "sess_20260511T203845_16d33281" → "16d33281" (last _-delimited segment).
// Recipient ID with no underscore (e.g. "orchestrator-1") uses the full value.
function wakeRecipientShort(eventName: string): string {
  const sessId = eventName.replace(/^(orchestrator\.)?filter\.wake\./, "");
  if (!sessId) return "";
  const parts = sessId.split("_");
  return parts.length > 1 ? (parts[parts.length - 1] ?? sessId) : sessId;
}

const SKIP_EVENTS = new Set([
  "session.heartbeat",
  "orchestrator.archived",
  "session.started",
  "session.ended",
]);

export function shouldSkipEvent(event: CanonicalEvent): boolean {
  const name = event.attributes?.["event.name"];
  if (!name) return true; // skip legacy/malformed events missing the canonical envelope
  if (SKIP_EVENTS.has(name)) return true;
  if (name === "github.check_run.completed") {
    const c = event.attributes["cicd.pipeline.run.conclusion"];
    if (c === "success" || c === "neutral" || c === "skipped") return true;
  }
  if (name.startsWith("filter.wake")) {
    const payload = event.body?.payload as Record<string, string> | undefined;
    const reason = payload?.reason ?? "";
    if (reason.includes("No matching events found")) return true;
  }
  return false;
}

export function formatTime(event: CanonicalEvent): string {
  const d = new Date(event.ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatDateTime(event: CanonicalEvent): string {
  const d = new Date(event.ts);
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss}`;
}

export function formatRepo(event: CanonicalEvent): string {
  const repo =
    event.attributes["vcs.repository.name"] ??
    event.attributes["linear.team.key"] ??
    "";
  return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
}

// CTL-355: classifySource is the pure label resolver — single source of truth
// for what the SOURCE column says. formatSource adds the Nerd Font icon
// prefix on top. Tests cover both functions so a future icon-only mode
// (deferred) can rely on classifySource alone.
function classifySource(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  if (!name) return "legacy";
  if (name.startsWith("github.")) return "github";
  if (name.startsWith("linear.")) return "linear";
  if (name === "comms.message.posted") {
    const label = event.attributes["event.label"];
    if (label) return label;
    const worker = event.attributes["catalyst.worker.ticket"];
    if (worker) return worker;
    return "comms";
  }
  // CTL-337: filter.wake events are always emitted by the broker; the
  // orchestrator id on the wake is the recipient, not the source. Return
  // "broker" so the SOURCE column shows who actually sent the event.
  if (name.startsWith("filter.wake.") || name.startsWith("orchestrator.filter.wake.")) {
    return "broker";
  }
  // CTL-331: recognise filter.* and the legacy orchestrator.filter.* alias.
  // Surface the orchestrator id when present so users can correlate filter
  // events back to a specific orchestrator run.
  if (name.startsWith("filter.") || name.startsWith("orchestrator.filter.")) {
    const orchId = event.attributes["catalyst.orchestrator.id"];
    return orchId ?? "filter";
  }
  if (name.startsWith("broker.daemon")) return "broker";
  const orchId = event.attributes["catalyst.orchestrator.id"];
  const worker = event.attributes["catalyst.worker.ticket"];
  if (orchId && worker) return `${orchId}/${worker}`;
  if (orchId) return orchId;
  return "system";
}

export function formatSource(event: CanonicalEvent): string {
  const label = classifySource(event);
  return `${sourceIcon(label)}${label}`;
}

// CTL-391: EVENT column now shows the raw `event.name` attribute verbatim.
// The pre-CTL-391 friendly-label map (`merged`, `ci pass`, `wake`, etc.) is
// gone — operators asked to see the actual event name as emitted, not an
// interpreted gloss. Overflow is the renderer's problem; Ink's
// `wrap="truncate"` on the EVENT cell clips with ellipsis instead of
// reflowing onto the next visual row.
export function formatEvent(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  return name ?? "(legacy)";
}

// CTL-391: ICON column renderer. Returns a single Nerd Font glyph for the
// event's source family, or "" when no Nerd Font is detected (the cell
// renders blank but its width is still reserved so the rest of the row
// stays column-aligned). Pre-CTL-391 this glyph was concatenated inside the
// EVENT column string by `formatSourceEvent`; pulling it back out into its
// own 1-cell column lets EVENT show the full raw name without losing the
// at-a-glance source signal.
//
// Comms messages anchor on the speech-bubble glyph rather than running
// through `classifySource` (which returns the sender's worker ticket for
// comms events) so the icon stays semantically correct regardless of which
// worker sent the message.
export function formatIcon(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  const family = name === "comms.message.posted" ? "comms" : classifySource(event);
  const raw = sourceIcon(family); // "{glyph} " or "" depending on Nerd Font detection
  // sourceIcon returns "{glyph} " (glyph + trailing space) sized for inline
  // composition with a label. The ICON column has its own marginRight, so
  // strip the trailing space and emit just the BMP glyph.
  const cp = raw.codePointAt(0);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

// CTL-350: STATUS column glyph. One char + trailing space so the column width
// is exactly 2 — keeps `<Box width={2}>` rendering on a single visual cell
// even when the terminal applies bold/inverse styling. CI conclusion drives
// the glyph for check_suite/check_run events; severity is the fallback for
// everything else so error/warn rows still get a visible marker.
// CTL-353: in-progress glyph routes through inProgressGlyph() so terminals
// with a Nerd Font get a single-cell PUA hourglass and everything else gets a
// single-cell ellipsis. The old ⏳ (U+23F3) is unreliable because terminals
// disagree on its East Asian width.
export function formatStatus(event: CanonicalEvent): string {
  const attrs = event.attributes ?? ({} as CanonicalEvent["attributes"]);
  const conclusion = attrs["cicd.pipeline.run.conclusion"];
  if (conclusion === "success") return "✓ ";
  if (conclusion === "failure" || conclusion === "cancelled") return "✗ ";
  const name = attrs["event.name"];
  if (conclusion === "in_progress" || (typeof name === "string" && name.includes(".in_progress"))) {
    return `${inProgressGlyph()} `;
  }
  const sev = event.severityText;
  if (sev === "ERROR") return "✗ ";
  if (sev === "WARN") return "! ";
  return "· ";
}

export function formatOrch(event: CanonicalEvent): string {
  return event.attributes?.["catalyst.orchestrator.id"] ?? "";
}

export function formatWorker(event: CanonicalEvent): string {
  return event.attributes?.["catalyst.worker.ticket"] ?? "";
}

export function formatRef(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  if (name === "comms.message.posted") {
    const payload = event.body?.payload as Record<string, unknown> | undefined;
    const to = payload?.["to"];
    if (typeof to === "string" && to.length > 0) return `→${to}`;
    const channel = payload?.["channel"];
    if (typeof channel === "string" && channel.length > 0) return channel;
    return "";
  }
  // CTL-348: filter.wake.* events route to a specific session/orchestrator id —
  // surface that id in REF so the operator can tell whose wake fired. The
  // SOURCE column already says "broker", so REF only needs the target id with
  // the "filter.wake." prefix stripped for readability.
  if (name?.startsWith("filter.wake.") || name?.startsWith("orchestrator.filter.wake.")) {
    const stripped = name.replace(/^(orchestrator\.)?filter\.wake\./, "");
    if (stripped.length > 0) return stripped;
  }
  // CTL-337: filter.register events watch a specific set of tickets (semantic
  // interest) or a specific repo (structured interest like pr_lifecycle).
  // Surface that in REF so the user sees what the registration observes.
  if (name?.startsWith("filter.register") || name?.startsWith("orchestrator.filter.register")) {
    const payload = event.body?.payload as Record<string, unknown> | undefined;
    const ctx = payload?.["context"] as Record<string, unknown> | undefined;
    const tickets = ctx?.["tickets"];
    if (Array.isArray(tickets) && tickets.length > 0) {
      return (tickets as string[]).join(",");
    }
    const repo = payload?.["repo"];
    if (typeof repo === "string" && repo.length > 0) {
      return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
    }
  }
  // CTL-355: PR numbers get a glyph prefix —  (nf-cod-git_pull_request)
  // when Nerd Font is detected, "#" otherwise.
  const pr = event.attributes["vcs.pr.number"];
  if (pr) return `${prPrefix()}${pr}`;
  const ticket = event.attributes["linear.issue.identifier"];
  if (ticket) return ticket;
  const branch = event.attributes["vcs.ref.name"];
  if (branch) return `→${branch}`;
  return "";
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      const cp = parseInt(ref.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (ref.startsWith("#")) {
      const cp = parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
  });
}

function stripImages(s: string): string {
  return s.replace(/<img\b[^>]*?>/gi, (tag: string) => {
    const m = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const alt = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    return alt ? `[${alt}]` : "[image]";
  });
}

function unwrapAnchors(s: string): string {
  return s.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, "$1");
}

const BLOCK_TAGS = new Set([
  "br",
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "li",
  "ul",
  "ol",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
]);

function stripTags(s: string): string {
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, name: string) =>
    BLOCK_TAGS.has(name.toLowerCase()) ? "\n" : "",
  );
}

function stripMarkdown(s: string): string {
  return s
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<![\w*])\*([^*\n]+?)\*(?!\w)/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+?)_(?!\w)/g, "$1");
}

function sanitize(input: string, mode: "oneline" | "multiline"): string {
  if (!input) return "";
  let s = input;
  s = stripImages(s);
  s = unwrapAnchors(s);
  s = stripTags(s);
  s = decodeEntities(s);
  s = stripMarkdown(s);
  if (mode === "oneline") {
    s = s.replace(/\s+/g, " ");
  } else {
    s = s
      .split(/\n/)
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return s.trim();
}

const detailsCache = new WeakMap<CanonicalEvent, string>();
const bodyCache = new WeakMap<CanonicalEvent, string>();

export function formatDetails(event: CanonicalEvent): string {
  const cached = detailsCache.get(event);
  if (cached !== undefined) return cached;
  const name = event.attributes?.["event.name"];
  const payload = event.body?.payload;
  // CTL-348/CTL-350: filter.wake.* events render their triggering context so
  // operators can see *why* the broker woke an orchestrator. When the wake
  // carries structured source_events (CTL-350 Phase 2), prefer those fields
  // over the Groq reason string — they're authoritative and pre-extracted.
  // Falls back to reason-based rendering for legacy events emitted before
  // Phase 2. The 40-char truncation from CTL-348 is removed; Phase 3's
  // <Text wrap="wrap"> on the DETAILS column handles overflow at render time.
  if (name?.startsWith("filter.wake.") || name?.startsWith("orchestrator.filter.wake.")) {
    const p = payload as Record<string, unknown> | undefined;
    // CTL-419: append a short recipient identifier to every wake DETAILS cell so
    // operators can see who is being woken even on narrow terminals where REF clips.
    const recipientSuffix = ` → ${wakeRecipientShort(name)}`;

    // CTL-419: multi-stale batch path — broker now emits stale_sessions[] when
    // multiple sessions go stale for the same interest simultaneously.
    const staleSessions = Array.isArray(p?.["stale_sessions"])
      ? (p["stale_sessions"] as string[])
      : null;
    if (staleSessions !== null && staleSessions.length > 1) {
      const out = sanitize(
        `wake → ${staleSessions.length} sessions stale${recipientSuffix}`,
        "oneline",
      );
      detailsCache.set(event, out);
      return out;
    }

    const sourceEvents = Array.isArray(p?.["source_events"])
      ? (p["source_events"] as Array<Record<string, unknown>>)
      : [];
    if (sourceEvents.length > 0) {
      const first = sourceEvents[0] ?? {};
      const evName = typeof first["name"] === "string" ? first["name"] : "event";
      const ticket = typeof first["ticket"] === "string" ? first["ticket"] : null;
      const pr = first["pr"];
      const ref = ticket
        ?? (typeof pr === "number" || (typeof pr === "string" && pr.length > 0) ? `#${pr}` : "");
      const excerpt = first["payload_excerpt"] as Record<string, unknown> | undefined;
      const state = excerpt?.["state"] ?? excerpt?.["conclusion"] ?? excerpt?.["action"];
      // Only stringify primitives so we never render "[object Object]" if a
      // future producer puts a nested shape under one of these excerpt keys.
      const isPrimitive =
        typeof state === "string"
        || typeof state === "number"
        || typeof state === "boolean";
      const stateSuffix = isPrimitive ? ` → ${String(state)}` : "";
      const countSuffix = sourceEvents.length > 1 ? ` (${sourceEvents.length})` : "";
      const out = `wake ← ${evName}${ref ? ` ${ref}` : ""}${stateSuffix}${countSuffix}${recipientSuffix}`
        .replace(/\s+/g, " ")
        .trim();
      const sanitized = sanitize(out, "oneline");
      detailsCache.set(event, sanitized);
      return sanitized;
    }
    const reasonRaw = typeof p?.["reason"] === "string" ? p["reason"] : "";
    const ids = p?.["source_event_ids"];
    const count = Array.isArray(ids) ? ids.length : 0;
    const reasonShort = sanitize(reasonRaw, "oneline");
    const suffix = count > 1 ? ` (${count})` : "";
    const out = reasonShort
      ? `wake → ${reasonShort}${suffix}${recipientSuffix}`
      : `wake${suffix}${recipientSuffix}`;
    detailsCache.set(event, out);
    return out;
  }
  // CTL-348: broker.daemon.* events occasionally carry a free-form detail
  // string in their payload. Surface it when present; otherwise fall through
  // to the generic payload/message handler below so structured payloads
  // (pid, recovered_interests, …) still produce a non-empty cell.
  if (name?.startsWith("broker.daemon.")) {
    const p = payload as Record<string, unknown> | undefined;
    const detail = p?.["detail"];
    if (typeof detail === "string" && detail.length > 0) {
      const out = sanitize(detail, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  // CTL-337: filter.register events carry a human-readable prompt (semantic
  // interest) or an interest_type + repo (structured interest). Surface that
  // in DETAILS so the user sees *why* the registration was made.
  if (name?.startsWith("filter.register") || name?.startsWith("orchestrator.filter.register")) {
    const p = payload as Record<string, unknown> | undefined;
    const prompt = p?.["prompt"];
    if (typeof prompt === "string" && prompt.length > 0) {
      const out = sanitize(prompt, "oneline");
      detailsCache.set(event, out);
      return out;
    }
    const itype = p?.["interest_type"];
    if (typeof itype === "string" && itype.length > 0) {
      const repo = p?.["repo"];
      const text = typeof repo === "string" && repo.length > 0 ? `${itype} ${repo}` : itype;
      const out = sanitize(text, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  // CTL-374: session.context — compact per-tick Claude Code metadata summary.
  // Reads typed attributes first (canonical source), falls back to payload.
  // Format: "24% · 245k tok · t126 · $23.02 · claude-opus-4-7"
  if (name === "session.context") {
    const p = (payload as Record<string, unknown> | undefined) ?? {};
    const pct = pickNumber(event.attributes?.["claude.context.used_pct"], p["context_pct"]);
    const tok = pickNumber(event.attributes?.["claude.context.tokens"], p["context_tokens"]);
    const turn = pickNumber(event.attributes?.["claude.turn"], p["turn"]);
    const cost = typeof p["cost_usd"] === "number" ? p["cost_usd"] : null;
    const model = typeof event.attributes?.["claude.model"] === "string"
      ? event.attributes["claude.model"]
      : (typeof p["model"] === "string" ? p["model"] : "");
    const parts: string[] = [];
    if (pct !== null) parts.push(`${pct}%`);
    if (tok !== null) parts.push(`${formatTokens(tok)} tok`);
    if (turn !== null) parts.push(`t${turn}`);
    if (cost !== null) parts.push(`$${cost.toFixed(2)}`);
    if (model) parts.push(model);
    const out = sanitize(parts.length > 0 ? parts.join(" · ") : "context tick", "oneline");
    detailsCache.set(event, out);
    return out;
  }
  // CTL-374: attention.context_pressure — threshold crossing summary.
  // Format: "context 50% → 72% (>70)"
  if (name === "attention.context_pressure") {
    const p = (payload as Record<string, unknown> | undefined) ?? {};
    const prev = pickNumber(p["prev_pct"]);
    const next = pickNumber(p["new_pct"]);
    const thr = pickNumber(p["threshold"]);
    let out = "context pressure";
    if (prev !== null && next !== null && thr !== null) {
      out = `context ${prev}% → ${next}% (>${thr})`;
    } else if (event.body?.message) {
      out = event.body.message;
    }
    const sanitized = sanitize(out, "oneline");
    detailsCache.set(event, sanitized);
    return sanitized;
  }
  // CTL-418: per-event-class structured DETAILS for GitHub and Linear events.
  // Attributes are authoritative; payload fields used as fallback when needed.
  if (name?.startsWith("github.pr.")) {
    const prNum = event.attributes?.["vcs.pr.number"];
    // Derive verb from event.name suffix (already normalized: "closed"+"merged"→"merged")
    let verb = name.slice("github.pr.".length);
    if (verb === "synchronize") verb = "pushed";
    if (verb === "ready_for_review") verb = "ready";
    if (typeof prNum === "number") {
      const out = sanitize(`PR #${prNum} ${verb}`, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  if (name?.startsWith("github.check_suite.")) {
    const p = payload as Record<string, unknown> | undefined;
    const conclusion =
      event.attributes?.["cicd.pipeline.run.conclusion"] ?? p?.["conclusion"];
    if (typeof conclusion === "string" && conclusion.length > 0) {
      const out = sanitize(`CI: ${conclusion}`, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  if (name?.startsWith("github.workflow_run.")) {
    const p = payload as Record<string, unknown> | undefined;
    const wfName =
      event.attributes?.["cicd.pipeline.name"] ??
      (typeof p?.["name"] === "string" ? p["name"] : undefined);
    const conclusion =
      event.attributes?.["cicd.pipeline.run.conclusion"] ??
      (typeof p?.["conclusion"] === "string" ? p["conclusion"] : undefined);
    if (typeof wfName === "string" && wfName.length > 0) {
      const suffix =
        typeof conclusion === "string" && conclusion.length > 0
          ? `: ${conclusion}`
          : "";
      const out = sanitize(`${wfName}${suffix}`, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  if (name?.startsWith("linear.issue.")) {
    const p = payload as Record<string, unknown> | undefined;
    const identifier =
      event.attributes?.["linear.issue.identifier"] ??
      (typeof p?.["ticket"] === "string" ? p["ticket"] : undefined);
    const suffix = name.slice("linear.issue.".length).replace(/_/g, " ");
    if (typeof identifier === "string" && identifier.length > 0) {
      const out = sanitize(`${identifier}: ${suffix}`, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  if (name === "session.phase") {
    const p = payload as Record<string, unknown> | undefined;
    const phaseName = typeof p?.["to"] === "string" ? p["to"] : "";
    if (phaseName.length > 0) {
      const out = sanitize(phaseName, "oneline");
      detailsCache.set(event, out);
      return out;
    }
  }
  const msg = event.body?.message ?? "";
  let raw = msg;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const title = p["title"];
    if (typeof title === "string") {
      raw = title;
    } else {
      const body = p["body"];
      if (typeof body === "string") raw = body.slice(0, 300);
    }
  }
  let out = sanitize(raw, "oneline");
  // CTL-391: comms.message.posted used to compose sender + type into the
  // EVENT cell ("ADV-939: info"). EVENT now shows the raw event.name
  // ("comms.message.posted"), so the sender + type would otherwise vanish.
  // Prepend "<sender>: <type> — " to DETAILS so the information lands in
  // the natural place — DETAILS already carries the message body for comms
  // events, and the prefix reads cleanly with the body.
  if (name === "comms.message.posted") {
    const sender = event.attributes?.["event.label"]
      ?? event.attributes?.["catalyst.worker.ticket"];
    const p = payload as Record<string, unknown> | undefined;
    const rawType = p?.["type"];
    const type = typeof rawType === "string" && rawType.length > 0 ? rawType : "comms";
    const senderText = typeof sender === "string" && sender.length > 0 ? `${sender}: ` : "";
    const prefix = `${senderText}${type}`;
    out = out.length > 0 ? `${prefix} — ${out}` : prefix;
  }
  detailsCache.set(event, out);
  return out;
}

// CTL-374 helpers — used only by session.context / attention.context_pressure
// arms above. Coerces the first non-null numeric source to a number; returns
// null otherwise.
function pickNumber(...candidates: Array<unknown>): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && c.length > 0) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// Compact a token count into a human-readable suffix ("245k", "1.2m", "950").
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}m`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function formatDetailBody(event: CanonicalEvent): string {
  const cached = bodyCache.get(event);
  if (cached !== undefined) return cached;
  const msg = event.body?.message ?? "";
  const out = sanitize(msg, "multiline");
  bodyCache.set(event, out);
  return out;
}
