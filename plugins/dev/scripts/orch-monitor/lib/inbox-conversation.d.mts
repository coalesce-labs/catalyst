// Type declarations for inbox-conversation.mjs (CTL-1569) — the composition layer
// behind the inbox conversation surface. Lets the strict TS server import it without
// a TS7016 implicit-any error. Keep in sync with inbox-conversation.mjs.

import type { InboxAsk } from "./inbox-ask.d.mts";
import type { ThreadComment, TicketThread } from "./linear-thread.d.mts";

/** The single payload the GET /api/ticket/<t>/thread route serves. */
export interface Conversation {
  ticket: string;
  /** Deep link to the Linear ticket (§3); null when the issue did not resolve. */
  url: string | null;
  title: string | null;
  thread: {
    /** false = the replica could not be READ. Distinct from an empty thread, so
     *  the UI can stay silent rather than claiming "no comments". */
    available: boolean;
    /** NEWEST FIRST (§2). */
    comments: ThreadComment[];
    reason: string | null;
  };
  ask: InboxAsk | null;
  /** false ONLY when a READABLE replica positively has no such issue — i.e. a
   *  synthesized row with nothing to reply to (§4 / orphan-PR rows). An UNREADABLE
   *  replica is not evidence of absence, so it stays true and the server-side post
   *  404s honestly if the issue really is gone. */
  canReply: boolean;
}

/** The global config carrying the app-actor `botUserId`s. Fails open to null. */
export function loadGlobalConfig(opts?: {
  path?: string | null;
  env?: Record<string, string | undefined>;
}): Promise<unknown>;

/** The Layer-2 project secrets file, carrying the operator's personal
 *  `linear.apiToken` — the only Linear credential on the launchd path. Fails open. */
export function loadProjectConfig(opts?: {
  projectKey?: string | null;
  repoConfigPath?: string | null;
  env?: Record<string, string | undefined>;
}): Promise<unknown>;

/** The configured secrets directory, honoring CATALYST_CONFIG_DIR. */
export function configDir(env?: Record<string, string | undefined>): string;

/** The Layer-1 repo config (`.catalyst/config.json`). Fails open to null. */
export function loadRepoConfig(opts?: { path?: string | null }): Promise<unknown>;

/** Can this explanation produce an ask deriveAsk can actually use? */
export function isUsableExplanation(expl: unknown): boolean;

/** The Catalyst data root, honoring CATALYST_DIR. */
export function catalystDir(env?: Record<string, string | undefined>): string;
export function defaultWorkersDir(env?: Record<string, string | undefined>): string;

/** Phases whose signals may carry an escalation explanation — PHASE_ORDER plus the
 *  ancillary `remediate`/`recovery-pass` (where rich escalations are authored). */
export const EXPLANATION_PHASES: readonly string[];

/** The newest explanation object, VERBATIM — preserving `ask` and `options`, which
 *  board-data's projecting deriveExplanation discards. */
export function deriveRichExplanation(
  phaseSigs: Record<string, unknown>[],
): Record<string, unknown> | null;

/** The ticket's phase signals in canonical order. A missing worker dir yields []
 *  — the common parked case, not an error. */
export function readPhaseSignals(
  ticket: string,
  opts?: {
    workersDir?: string | null;
    read?: (path: string, encoding: "utf8") => Promise<string>;
    env?: Record<string, string | undefined>;
  },
): Promise<Record<string, unknown>[]>;

export function getConversation(
  ticket: string,
  opts?: {
    limit?: number;
    readThread?: (
      ticket: string,
      opts: { limit: number; botUserIds: ReadonlySet<string> },
    ) => Promise<TicketThread>;
    readSignals?: (
      ticket: string,
      opts: { workersDir: string | null; env?: Record<string, string | undefined> },
    ) => Promise<Record<string, unknown>[]>;
    workersDir?: string | null;
    env?: Record<string, string | undefined>;
    config?: unknown;
    /** Layer-1 repo config — carries the LEGACY `catalyst.monitor.linear.botUserId`
     *  the read path needs for a correct agent/human split. */
    repoConfig?: unknown;
    /** Explicit Layer-1 config path (server-resolved). Never rely on process.cwd():
     *  the launchd wrapper sets no working directory. */
    repoConfigPath?: string | null;
  },
): Promise<Conversation>;
