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
  if (name === "comms.message.posted") return "comms";
  if (name.startsWith("filter.")) return "filter";
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
  "comms.message.posted": "comms",
  "session.phase": "phase",
};

export function formatEvent(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  if (!name) return "(legacy)";
  if (name === "github.check_suite.completed") {
    const c = event.attributes["cicd.pipeline.run.conclusion"];
    return c === "success" ? "ci pass" : "ci fail";
  }
  const label = EVENT_LABELS[name] ?? name;
  return label.slice(0, 15);
}

export function formatRef(event: CanonicalEvent): string {
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
  const payload = event.body?.payload;
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
