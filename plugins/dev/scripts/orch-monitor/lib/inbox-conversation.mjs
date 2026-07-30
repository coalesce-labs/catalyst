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

import { ANCILLARY_EXPLANATION_PHASES, PHASE_ORDER } from "./board-data.mjs";
import { askFromExplanation, askFromStructured, deriveAsk } from "./inbox-ask.mjs";
import { knownBotUserIds } from "./linear-comment.mjs";
import { DEFAULT_THREAD_LIMIT, readTicketThread } from "./linear-thread.mjs";

const HOME = homedir();

/** The Catalyst data root. Honors CATALYST_DIR like the rest of the tree
 *  (governance-reader.mjs, execution-core/config.mjs) — hardcoding `~/catalyst`
 *  would silently read the WRONG worker tree on an installation with a
 *  non-default root, losing every phase-backed ask. */
export function catalystDir(env = process.env) {
  return env.CATALYST_DIR || join(HOME, "catalyst");
}

export function defaultWorkersDir(env = process.env) {
  return join(catalystDir(env), "execution-core", "workers");
}

/**
 * The phases whose signals can carry an escalation explanation, newest-LAST.
 *
 * PHASE_ORDER alone is NOT enough: `remediate` and `recovery-pass` are
 * deliberately excluded from it, and **recovery-pass is where the rich escalation
 * explanation is actually authored**. board-data.mjs reads
 * ANCILLARY_EXPLANATION_PHASES separately for exactly this reason, so scanning
 * only PHASE_ORDER makes a recovery-pass-only escalation lose its structured ask
 * and fall back to the far less reliable comment inference.
 *
 * Ancillary phases go LAST so the newest-first scan prefers them — a
 * recovery-pass explanation supersedes the canonical phase that preceded it.
 */
export const EXPLANATION_PHASES = [...PHASE_ORDER, ...ANCILLARY_EXPLANATION_PHASES];

/**
 * The escalation explanation for the ask derivation, scanned newest-first.
 *
 * NOT board-data.mjs::deriveExplanation — that function PROJECTS the six legacy
 * string fields (`call_to_action`, `outcome`, `problem`, `why_you`,
 * `why_not_auto`, `what_to_do`) and discards everything else. Routing the ask
 * through it silently threw away both `explanation.ask` (the producer-authored
 * structured ask) and `explanation.options` (the source of the suggested-reply
 * chips) — so the "structured" preference tier could never fire and chips could
 * never render. This returns the explanation object VERBATIM instead.
 */
export function deriveRichExplanation(phaseSigs) {
  let firstShaped = null;
  for (let i = phaseSigs.length - 1; i >= 0; i--) {
    const sig = phaseSigs[i];
    if (!sig || typeof sig !== "object") continue;
    const expl = sig.explanation;
    if (!expl || typeof expl !== "object") continue;
    if (firstShaped === null) firstShaped = expl;
    // Keep scanning past an explanation that carries nothing deriveAsk can use.
    // A newer legacy/partial signal (only `human_question`, `what_failed`, …)
    // would otherwise MASK an older one holding a real `ask` / `call_to_action`,
    // dropping the pane to comment inference or to no ask at all.
    if (isUsableExplanation(expl)) return expl;
  }
  // Nothing usable anywhere → return the newest shaped one so any passthrough
  // consumer still sees what the producer wrote (deriveAsk will yield null).
  return firstShaped;
}

/** Can this explanation actually produce an ask? Mirrors what inbox-ask.mjs reads:
 *  a structured `ask`, enumerated `options`, or the CTA / what-to-do prose. */
export function isUsableExplanation(expl) {
  if (!expl || typeof expl !== "object") return false;
  // Mirror askFromStructured EXACTLY: it requires a recognized `kind` AND a
  // summary, so accepting `{ ask: { summary } }` here declares an explanation
  // usable that then produces nothing — reproducing the very masking regression
  // this predicate exists to prevent.
  const ask = expl.ask;
  if (ask && typeof ask === "object" && askFromStructured({ ask }) != null) return true;
  // Run the DOWNSTREAM check, not a shape check: askFromExplanation normalizes and
  // de-duplicates option labels and needs two VALID ones, so `[{}, {}]` or
  // `["A","a"]` would pass a naive length test, stop the scan, and then produce no
  // ask — masking an older valid explanation all over again.
  // NOTE: pass ONLY the options. Injecting a call_to_action here would make the
  // CTA branch succeed for ANY input and defeat the whole check.
  if (Array.isArray(expl.options) && askFromExplanation({ options: expl.options }) != null) {
    return true;
  }
  for (const k of ["call_to_action", "what_to_do"]) {
    if (typeof expl[k] === "string" && expl[k].trim() !== "") return true;
  }
  return false;
}

/** The global config that carries the app-actor `botUserId`s the authorship gate
 *  cross-checks. Read lazily per call and fail-open to null — the gate's primary
 *  defense is the `viewer` shape check, which needs no config. */
/** The configured secrets directory. `server.ts` already honors CATALYST_CONFIG_DIR
 *  for OTel and webhook secrets; constructing a second hardcoded `~/.config/catalyst`
 *  here made the reply route miss `config-<projectKey>.json` on such an install, so
 *  every reply returned `no_token` while the credential sat in the configured dir. */
export function configDir(env = process.env) {
  return env.CATALYST_CONFIG_DIR || join(HOME, ".config", "catalyst");
}

export async function loadGlobalConfig({ path = null, env = process.env } = {}) {
  const resolved = path ?? join(configDir(env), "config.json");
  try {
    return JSON.parse(await readFile(resolved, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The Layer-2 project secrets file (`~/.config/catalyst/config-<projectKey>.json`).
 * Carries the operator's personal `linear.apiToken` — the only Linear credential
 * available on the launchd path, where no token is exported into the environment.
 * `projectKey` is resolved from the Layer-1 repo config when not supplied.
 * Fail-open to null: the reply then reports `no_token` loudly rather than throwing.
 */
export async function loadProjectConfig({
  projectKey = null,
  repoConfigPath = null,
  env = process.env,
} = {}) {
  try {
    // `repoConfigPath` MUST be supplied by the server (it already resolves the
    // Layer-1 path via --config / CATALYST_CONFIG_PATH). Falling back to
    // `process.cwd()` is not viable on the persistent launch path: the committed
    // launchd wrapper sets neither a working directory nor CATALYST_PROJECT_KEY, so
    // a cwd-relative lookup misses and every reply returns `no_token` — the very
    // inertness this fallback exists to prevent.
    let key = projectKey ?? env.CATALYST_PROJECT_KEY ?? null;
    if (key == null) {
      const p = repoConfigPath ?? join(process.cwd(), ".catalyst", "config.json");
      const repo = JSON.parse(await readFile(p, "utf8"));
      key = repo?.catalyst?.projectKey ?? repo?.projectKey ?? null;
    }
    if (typeof key !== "string" || key === "") return null;
    const path = join(configDir(env), `config-${key}.json`);
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The Layer-1 repo config (`.catalyst/config.json`). The legacy app-actor id lives
 * here as `catalyst.monitor.linear.botUserId`, and the GET /thread path needs it:
 * without it, a legacy installation classifies every Catalyst app comment as HUMAN
 * (they carry is_bot=0), which empties `agentComments` and kills the derived ask.
 * Fail-open to null.
 */
export async function loadRepoConfig({ path = null } = {}) {
  try {
    const p = path ?? join(process.cwd(), ".catalyst", "config.json");
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** Read the ticket's phase signals in scan order (oldest→newest, ancillary last),
 *  so the newest-first explanation scan finds the most recent escalation. A
 *  missing worker dir yields [] — the common parked case, not an error. */
export async function readPhaseSignals(
  ticket,
  { workersDir = null, read = readFile, env = process.env } = {},
) {
  const dir = workersDir ?? defaultWorkersDir(env);
  const sigs = await Promise.all(
    EXPLANATION_PHASES.map(async (phase) => {
      try {
        return JSON.parse(await read(join(dir, ticket, `phase-${phase}.json`), "utf8"));
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
    workersDir = null,
    env = process.env,
    /** Pre-loaded global config; when omitted it is read here. Carries the
     *  app-actor ids that make the agent/human split correct (a Catalyst app
     *  actor's comments have is_bot=0 — see linear-thread.mjs::normalizeComment). */
    config = undefined,
    /** Layer-1 repo config — carries the LEGACY `catalyst.monitor.linear.botUserId`
     *  that the read path also needs for a correct agent/human split. */
    repoConfig = undefined,
    repoConfigPath = null,
  } = {},
) {
  const [cfg, repoCfg] = await Promise.all([
    config === undefined ? loadGlobalConfig() : Promise.resolve(config),
    repoConfig === undefined ? loadRepoConfig({ path: repoConfigPath }) : Promise.resolve(repoConfig),
  ]);
  const botUserIds = knownBotUserIds({ config: cfg, projectConfig: repoCfg });
  const [thread, phaseSigs] = await Promise.all([
    readThread(ticket, { limit, botUserIds }),
    readSignals(ticket, { workersDir, env }).catch(() => []),
  ]);

  const explanation = deriveRichExplanation(phaseSigs);
  const ask = deriveAsk({ explanation, agentComments: thread.agentComments });

  // No issue ROW in a READABLE replica → a synthesized card with nothing to reply
  // to. Keyed on the explicit `issueExists` bit, NOT on `url`: the deep link is
  // optional and can be null on a genuine issue (unpopulated / mid-sync), and using
  // it as the existence predicate hid the composer on tickets the POST path
  // resolves fine by identifier. An UNREADABLE replica is still not evidence of
  // absence, so it stays permissive (see the header note).
  const canReply = thread.available ? thread.issueExists === true : true;

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
