// inbox-conversation.mjs — the composition layer behind the inbox conversation
// surface (CTL-1569). The routes stay thin: this module assembles ONE payload from
// the three sources and owns the "can the operator reply here at all?" question.
//
// Sources, and why each:
//   • the REPLICA thread          (linear-thread.mjs)  — the comments, newest-first,
//                                                       zero Linear API calls.
//   • the phase-signal EXPLANATION (board-data.mjs)    — the producer's structured
//                                                       escalation fields, the
//                                                       preferred ask source.
//   • the newest AGENT comment     (from the thread)    — the ask FALLBACK, so
//                                                       tickets parked before any
//                                                       producer change still render.
//
// The ask derivation itself is pure (inbox-ask.mjs); this module only feeds it.
//
// REPLY ELIGIBILITY (§4's "rows with no underlying ticket show no reply
// affordance"): orphan-PR rows are SYNTHESIZED by the board with no Linear issue
// behind them, so there is nothing to comment on. The signal we use is the replica
// itself — an issue row resolves (giving us a `url`) or it does not. When the
// replica is UNAVAILABLE we deliberately allow the reply anyway: an unreadable
// local mirror is not evidence that the ticket does not exist, and refusing to let
// the operator answer a genuinely parked ticket because a local cache is locked
// would be the worse failure. The server-side post still 404s honestly if the
// issue truly is absent, so the optimistic direction is safe.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { PHASE_ORDER, deriveExplanation } from "./board-data.mjs";
import { deriveAsk } from "./inbox-ask.mjs";
import { knownBotUserIds } from "./linear-comment.mjs";
import { DEFAULT_THREAD_LIMIT, readTicketThread } from "./linear-thread.mjs";

const HOME = homedir();
const DEFAULT_WORKERS_DIR = join(HOME, "catalyst", "execution-core", "workers");

/** The global config that carries the app-actor `botUserId`s the authorship gate
 *  cross-checks. Read lazily per call and fail-open to null — the gate's primary
 *  defense is the `viewer` shape check, which needs no config. */
export async function loadGlobalConfig({
  path = join(HOME, ".config", "catalyst", "config.json"),
} = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Read the ticket's phase signals in canonical order (oldest→newest), so
 *  deriveExplanation's newest-first scan finds the most recent escalation. A
 *  missing worker dir yields [] — the common parked case, not an error. */
export async function readPhaseSignals(
  ticket,
  { workersDir = DEFAULT_WORKERS_DIR, read = readFile } = {},
) {
  const sigs = await Promise.all(
    PHASE_ORDER.map(async (phase) => {
      try {
        return JSON.parse(await read(join(workersDir, ticket, `phase-${phase}.json`), "utf8"));
      } catch {
        return null; // absent / unreadable / corrupt → simply not a source
      }
    }),
  );
  return sigs.filter((s) => s && typeof s === "object");
}

/**
 * Assemble the full conversation payload for one ticket.
 *
 * Returns (never throws):
 *   {
 *     ticket,
 *     url,            // deep link to the Linear ticket (§3); null when unresolved
 *     title,
 *     thread: { available, comments[], reason },
 *     ask,            // { kind, summary, suggestedReplies[], canResolveByReply, source } | null
 *     canReply,       // false ONLY when the replica positively has no such issue
 *   }
 */
export async function getConversation(
  ticket,
  {
    limit = DEFAULT_THREAD_LIMIT,
    readThread = readTicketThread,
    readSignals = readPhaseSignals,
    workersDir = DEFAULT_WORKERS_DIR,
    /** Pre-loaded global config; when omitted it is read here. Carries the
     *  app-actor ids that make the agent/human split correct (a Catalyst app
     *  actor's comments have is_bot=0 — see linear-thread.mjs::normalizeComment). */
    config = undefined,
  } = {},
) {
  const cfg = config === undefined ? await loadGlobalConfig() : config;
  const botUserIds = knownBotUserIds({ config: cfg });
  const [thread, phaseSigs] = await Promise.all([
    readThread(ticket, { limit, botUserIds }),
    readSignals(ticket, { workersDir }).catch(() => []),
  ]);

  const explanation = deriveExplanation(phaseSigs);
  const ask = deriveAsk({ explanation, agentComments: thread.agentComments });

  // No issue row in a READABLE replica → a synthesized row with nothing to reply
  // to. An UNREADABLE replica is not evidence of absence (see the header note).
  const canReply = thread.available ? thread.url != null : true;

  return {
    ticket,
    url: thread.url,
    title: thread.title,
    thread: {
      available: thread.available,
      comments: thread.comments,
      reason: thread.reason,
    },
    ask,
    canReply,
  };
}
