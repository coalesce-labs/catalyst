import type { CanonicalEvent } from "../../lib/canonical-event.ts";

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
  const repo = event.attributes["vcs.repository.name"] ?? "";
  return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
}

export function formatSource(event: CanonicalEvent): string {
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
  if (name === "broker.daemon.startup") return "broker";
  const orchId = event.attributes["catalyst.orchestrator.id"];
  const worker = event.attributes["catalyst.worker.ticket"];
  if (orchId && worker) return `${orchId}/${worker}`;
  if (orchId) return orchId;
  return "system";
}

const EVENT_LABELS: Record<string, string> = {
  "github.pr.merged": "merged",
  "github.pr.opened": "pr open",
  "github.pr.closed": "pr closed",
  "orchestrator.worker.done": "done",
  "orchestrator.worker.failed": "failed",
  "orchestrator.attention.raised": "attention",
  "session.phase": "phase",
  // CTL-331: filter daemon lifecycle events.
  "filter.register": "filter reg",
  "filter.deregister": "filter dereg",
  "filter.wake": "wake",
  "broker.daemon.startup": "broker start",
  // Legacy aliases for events written before catalyst-state.sh preserved the
  // bare filter.* name (CTL-331). Keeps older log lines readable.
  "orchestrator.filter.register": "filter reg",
  "orchestrator.filter.deregister": "filter dereg",
  "orchestrator.filter.wake": "wake",
};

export function formatEvent(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  if (!name) return "(legacy)";
  if (name === "github.check_suite.completed") {
    const c = event.attributes["cicd.pipeline.run.conclusion"];
    return c === "success" ? "ci pass" : "ci fail";
  }
  if (name === "comms.message.posted") {
    const payload = event.body?.payload as Record<string, unknown> | undefined;
    const type = payload?.["type"];
    if (typeof type === "string" && type.length > 0) return type.slice(0, 15);
    return "comms";
  }
  // CTL-331: wake events are session-scoped (filter.wake.{sessionId}).
  // EVENT_LABELS is exact-match, so handle the prefixed family explicitly.
  if (name.startsWith("filter.wake.") || name.startsWith("orchestrator.filter.wake.")) {
    return "wake";
  }
  const label = EVENT_LABELS[name] ?? name;
  return label.slice(0, 15);
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
  const pr = event.attributes["vcs.pr.number"];
  if (pr) return `#${pr}`;
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
  // CTL-348: filter.wake.* events carry a human-readable reason and an array of
  // source event ids. Render "wake → ${reason_short}" with an optional "(n)"
  // suffix when more than one source event triggered the wake so operators can
  // tell *why* the broker woke the orchestrator instead of seeing a blank cell.
  if (name?.startsWith("filter.wake.") || name?.startsWith("orchestrator.filter.wake.")) {
    const p = payload as Record<string, unknown> | undefined;
    const reasonRaw = typeof p?.["reason"] === "string" ? p["reason"] : "";
    const ids = p?.["source_event_ids"];
    const count = Array.isArray(ids) ? ids.length : 0;
    const reasonShort = sanitize(reasonRaw, "oneline").slice(0, 40);
    const suffix = count > 1 ? ` (${count})` : "";
    const out = reasonShort ? `wake → ${reasonShort}${suffix}` : `wake${suffix}`;
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
  const out = sanitize(raw, "oneline");
  detailsCache.set(event, out);
  return out;
}

export function formatDetailBody(event: CanonicalEvent): string {
  const cached = bodyCache.get(event);
  if (cached !== undefined) return cached;
  const msg = event.body?.message ?? "";
  const out = sanitize(msg, "multiline");
  bodyCache.set(event, out);
  return out;
}
