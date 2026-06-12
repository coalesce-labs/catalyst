// inbox-state.ts — compact worker-state collection for the per-inbox-item AI
// summary (CTL-1042). Reads the stuck worker's real state into InboxItemState:
// the held phase signal, triage.json summary, and the transcript tail / raised
// question. All I/O paths are injectable so tests run against temp fixtures.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

// Canonical pipeline phase order (mirrors PHASE_ORDER in board-data.mjs).
const PHASE_ORDER = [
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
  "monitor-deploy",
  "teardown",
];

// ── public interfaces ─────────────────────────────────────────────────────────

export interface InboxItemState {
  ticket: string;
  title: string | null;
  phase: string;
  status: string;
  failureReason: string | null;
  stalledReason: string | null;
  parkedFrom: string | null;
  handoffPath: string | null;
  triageSummary: string | null;
  /** The agent's trailing question/statement — extractWaitingText of the last
   *  assistant text block, capped at 200 chars. null when unresolvable. */
  raisedQuestion: string | null;
  /** Last ~1.5 k chars of the last assistant text block in the transcript.
   *  null when the transcript is absent or unreadable. */
  transcriptTail: string | null;
  bgJobId: string | null;
  /** CTL-1065: structured escalation question from signal.explanation.human_question.
   *  null when no explanation is present or the field is absent (back-compat). */
  humanQuestion: string | null;
}

export interface CollectOptions {
  /** ~/catalyst/execution-core/workers — the workers root. */
  workersDir: string;
  /** ~/.claude/projects — the Claude Code projects dir. */
  projectsDir: string;
  /** ~/.claude/jobs — the Claude Code bg-job state dir. Tests override this. */
  jobsDir?: string;
  /** The ticket title already resident on the board (no live Linear call). */
  title: string | null;
}

// ── internal helpers ──────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Scan the ticket's worker dir for the first `needs-input` signal (PHASE_ORDER
 *  precedence, mirrors findHeldRun in respond-ticket.mjs). Falls back to any
 *  `stalled` or `held` signal. Returns null when nothing is held. */
function findHeldSignal(
  ticket: string,
  workersDir: string,
): { phase: string; signal: Record<string, unknown> } | null {
  let files: string[];
  try {
    files = readdirSync(join(workersDir, ticket));
  } catch {
    return null;
  }
  const phaseFiles = new Set(
    files.filter((f) => f.startsWith("phase-") && f.endsWith(".json")),
  );

  // First pass: needs-input (the parked predicate)
  for (const phase of PHASE_ORDER) {
    const fname = `phase-${phase}.json`;
    if (!phaseFiles.has(fname)) continue;
    const sig = readJsonSafe(join(workersDir, ticket, fname));
    if (isRecord(sig) && sig.status === "needs-input") {
      return { phase, signal: sig };
    }
  }
  // Second pass: stalled / held fallback
  for (const phase of PHASE_ORDER) {
    const fname = `phase-${phase}.json`;
    if (!phaseFiles.has(fname)) continue;
    const sig = readJsonSafe(join(workersDir, ticket, fname));
    if (isRecord(sig) && (sig.status === "stalled" || sig.status === "held")) {
      return { phase, signal: sig };
    }
  }
  return null;
}

/** Read ~/.claude/jobs/<bgJobId>/state.json and return the sessionId, or null. */
function resolveSessionId(bgJobId: string, jobsDir: string): string | null {
  const state = readJsonSafe(join(jobsDir, bgJobId, "state.json"));
  if (!isRecord(state)) return null;
  return typeof state.sessionId === "string" ? state.sessionId : null;
}

/** Scan projectsDir for <sessionId>.jsonl (mirrors findTranscript in
 *  session-recency.mjs, but sync so this module stays IO-isolated). */
function findTranscriptPath(sessionId: string, projectsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const candidate = join(projectsDir, e, `${sessionId}.jsonl`);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // not in this project dir — keep scanning
    }
  }
  return null;
}

/** Port of extractWaitingText from wait-state-classifier.mjs: the trailing
 *  1–2 sentences + any dangling fragment, whitespace-collapsed, capped. */
function extractWaitingText(text: string, maxLen = 200): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return "";
  const sentences = trimmed.match(/[^.!?]+[.!?]+/g) ?? [];
  const tail2 = sentences.slice(-2).join(" ");
  const frag = trimmed.replace(/.*[.!?]/s, "");
  let out = `${tail2} ${frag}`.replace(/\s+/g, " ").trim();
  if (out === "") out = trimmed.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = `…${out.slice(-(maxLen - 1))}`;
  return out;
}

const TRANSCRIPT_TAIL_CAP = 1500;

/** Resolve the raised question and transcript tail from the bg job's transcript.
 *  Fail-open: any unreadable path returns { null, null }. */
function resolveTranscriptTail(
  bgJobId: string | null,
  projectsDir: string,
  jobsDir: string,
): { raisedQuestion: string | null; transcriptTail: string | null } {
  const none = { raisedQuestion: null, transcriptTail: null };
  if (!bgJobId) return none;

  const sessionId = resolveSessionId(bgJobId, jobsDir);
  if (!sessionId) return none;

  const transcriptPath = findTranscriptPath(sessionId, projectsDir);
  if (!transcriptPath) return none;

  let content: string;
  try {
    content = readFileSync(transcriptPath, "utf8");
  } catch {
    return none;
  }

  // Scan lines from the end to find the last assistant text block.
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  let lastAssistantText: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as unknown;
      if (!isRecord(record) || record.type !== "assistant") continue;
      const msg = isRecord(record.message) ? record.message : null;
      if (!msg) continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block: unknown = blocks[j];
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          lastAssistantText = block.text;
          break;
        }
      }
      if (lastAssistantText !== null) break;
    } catch {
      continue;
    }
  }

  if (!lastAssistantText) return none;

  const transcriptTail =
    lastAssistantText.length > TRANSCRIPT_TAIL_CAP
      ? `…${lastAssistantText.slice(-(TRANSCRIPT_TAIL_CAP - 1))}`
      : lastAssistantText;

  const raisedQuestion = extractWaitingText(lastAssistantText) || null;
  return { raisedQuestion, transcriptTail };
}

// ── public API ────────────────────────────────────────────────────────────────

/** Stable 12-char hex cache key component for (phase, question). */
export function computeQuestionHash(phase: string, question: string | null): string {
  return createHash("sha256")
    .update(`${phase}\n${question ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

/** Collect a stuck worker's state into a compact InboxItemState. Returns null
 *  when no stuck phase signal exists for the ticket. Fail-open on every I/O
 *  path: missing files degrade the relevant field to null, never throw. */
export function collectInboxItemState(
  ticket: string,
  opts: CollectOptions,
): Promise<InboxItemState | null> {
  const held = findHeldSignal(ticket, opts.workersDir);
  if (!held) return Promise.resolve(null);

  const { phase, signal } = held;
  const bgJobId = typeof signal.bg_job_id === "string" ? signal.bg_job_id : null;
  const jobsDir = opts.jobsDir ?? join(HOME, ".claude", "jobs");

  const triage = readJsonSafe(join(opts.workersDir, ticket, "triage.json"));
  const triageSummary =
    isRecord(triage) && typeof triage.summary === "string" ? triage.summary : null;

  const { raisedQuestion, transcriptTail } = resolveTranscriptTail(
    bgJobId,
    opts.projectsDir,
    jobsDir,
  );

  const expl = isRecord(signal.explanation) ? signal.explanation : null;
  const humanQuestion =
    expl !== null && typeof expl.human_question === "string" ? expl.human_question : null;

  return Promise.resolve({
    ticket,
    title: opts.title,
    phase,
    status: typeof signal.status === "string" ? signal.status : "unknown",
    failureReason: typeof signal.failureReason === "string" ? signal.failureReason : null,
    stalledReason: typeof signal.stalledReason === "string" ? signal.stalledReason : null,
    parkedFrom: typeof signal.parkedFrom === "string" ? signal.parkedFrom : null,
    handoffPath: typeof signal.handoffPath === "string" ? signal.handoffPath : null,
    triageSummary,
    raisedQuestion,
    transcriptTail,
    bgJobId,
    humanQuestion,
  });
}
