// codex-run-phase-agent.mjs — the `executor=codex-exec` launch verb (CTL-1457).
//
// Same SIGNATURE and RETURN SHAPE as dispatch.mjs:defaultRunPhaseAgent
//   ({ orchDir, ticket, phase, worktreePath, resumeSession, handoffPath,
//      attempt, clusterGeneration }) → { code, stdout, stderr, signal }
// — so it is drop-in beside the `--bg` and `sdk` launch verbs. It RETURNS a
// superset ({ …, usage, sessionId, classification, aborted }); dispatch.mjs
// spreads the object, so the extra fields ride through harmlessly.
//
// ── The Codex analog of sdk-run-phase-agent.mjs ─────────────────────────────
// Codex is NOT in-process: `codex exec --json` is a REAL child process that
// streams JSONL events on stdout (thread.started / turn.started / item.* /
// turn.completed / turn.failed / error). So where the SDK path drives an
// in-process query() and cancels via an AbortController ONLY, the codex path
// spawns a child (stdin CLOSED — the mandatory `</dev/null` stdin-hang fix),
// line-buffers its stdout, and cancels via BOTH the AbortController AND a real
// child.kill("SIGTERM") (+ a SIGKILL escalation) — an in-process abort cannot
// stop a subprocess.
//
// ── What it REUSES from the sdk module (no fork) ────────────────────────────
// The executor seam is only the LAUNCH VERB — everything upstream of the launch
// is byte-identical to the bg/sdk paths. So this module imports and reuses the
// EXPORTED sdk primitives: runPrelaunch (the Stage-A shared pre-launch: claim +
// fenced "dispatched" signal + generation + rebase + prompt/env composition),
// Semaphore + resolveMaxParallel (the process-wide concurrency cap),
// scrubSecrets (token redaction), flipSignalDoneOnSuccess (the success-branch
// signal backstop), defaultWriteSignalStalled (the stalled-signal flip) and
// defaultEmitBackstop (the terminal-event backstop). Only the launch verb —
// spawn `codex exec --json`, parse its JSONL, classify its errors — is new.
//
// ── Auth (the KEY divergence from the sdk path) ─────────────────────────────
// Codex authenticates via its OWN mechanism: a `codex login`-populated
// <CODEX_HOME>/auth.json (subscription ChatGPT) or a CODEX_API_KEY (metered).
// It must NOT carry the Claude subscription token, so buildCodexEnv DELETES
// ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN AND CLAUDE_CODE_OAUTH_TOKEN (the sdk
// path SETS the last one). assertCodexAuth refuses to dispatch (no claim, no
// signal) when neither auth source is present, and never reads/logs a token.
//
// ── Failure classification & park (D5: no `phase.*.park` event) ─────────────
// codex exec exits 1 for auth failure, usage-limit, and generic failure alike —
// exit code alone can't distinguish them, so we string-match the error message
// (case-insensitive). auth-park → a STICKY stalled signal (needs-human; do NOT
// loop). rate-park → a bounded in-runner retry, then return WITHOUT a stalled
// write (transient — the scheduler's cool-down retries later). generic failure
// → mark the still-in-flight signal failed (the sdk backstop). There is NO
// `phase.<phase>.park.<ticket>` event — park is the stalled-signal + the
// classification, consumed by the daemon's existing cool-down / circuit-breaker
// / needs-human machinery.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { codexConfig, log } from "./config.mjs";
import {
  defaultEmitBackstop,
  defaultWriteSignalStalled,
  flipSignalDoneOnSuccess,
  resolveMaxParallel,
  runPrelaunch,
  scrubSecrets,
  Semaphore,
} from "./sdk-run-phase-agent.mjs";
import { registerSdkWorker as defaultRegisterSdkWorker } from "./sdk-worker-registry.mjs";

const CODEX_EXECUTOR_ID = "codex-exec";

// One process-wide semaphore, lazily created at the configured size (the daemon
// is a single process). Mirrors the sdk module's shared cap but is codex-local
// (the sdk singleton is module-private). A node runs one executor in practice,
// so a per-executor cap is the right scope; see follow-ups if a mixed sdk+codex
// node ever needs a single shared cap.
let _sharedCodexSemaphore = null;
function sharedSemaphore(maxParallel) {
  if (_sharedCodexSemaphore) {
    if (_sharedCodexSemaphore.max !== maxParallel && typeof _sharedCodexSemaphore.setMax === "function") {
      _sharedCodexSemaphore.setMax(maxParallel);
    }
    return _sharedCodexSemaphore;
  }
  _sharedCodexSemaphore = new Semaphore(maxParallel);
  return _sharedCodexSemaphore;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// rateBackoffMs — bounded exponential backoff for the usage-limit retry. No
// jitter needed (the retry cap is tiny — maxRateRetries defaults to 2).
function rateBackoffMs(i, { baseMs = 1000, capMs = 30000 } = {}) {
  return Math.min(capMs, baseMs * 2 ** i);
}

// defaultEmitEvent — best-effort observability line (execution-core.codex.* /
// execution-core.auth.misconfigured / worker.session.*). The daemon injects a
// real unified-event-log writer at the dispatch seam; the default is a
// dependency-free stderr line. Never throws.
function defaultEmitEvent(name, payload) {
  try {
    process.stderr.write(
      `[codex-run-phase-agent] ${name} ${JSON.stringify(payload ?? {})}\n`,
    );
  } catch {
    /* best-effort */
  }
}

// defaultSpawnChild — the real async child spawn. Injectable so tests replace it
// with a fake EventEmitter child (deterministic parse / usage / abort) without a
// real `codex` binary.
function defaultSpawnChild(bin, args, opts) {
  return nodeSpawn(bin, args, opts);
}

// defaultMarkLaunchFailed — the generic-failure backstop: flip the still-in-flight
// signal to a terminal status AND emit the canonical terminal phase event, exactly
// like the sdk path's defaultEmitBackstop. Best-effort; never throws.
function defaultMarkLaunchFailed(
  { phase, ticket, status = "failed", reason, orchDir, signalFile },
  { spawn = spawnSync } = {},
) {
  defaultEmitBackstop({ phase, ticket, status, reason, orchDir, signalFile }, { spawn });
}

// ── Auth guard ──────────────────────────────────────────────────────────────
// assertCodexAuth — refuse to dispatch under codex-exec when no auth source is
// present. Returns { ok, reason }. `ok:true` when <codexHome>/auth.json exists
// AND parses with a `tokens` key (a `codex login`-populated subscription home),
// OR when CODEX_API_KEY is set (metered API-key mode — logged LOUDLY so the
// operator knows they are being billed per token, not on a subscription).
// NEVER reads or logs a token VALUE — it only tests for the presence of the
// `tokens` key / the env var. Mirrors assertSdkAuth's actionable-message style.
export function assertCodexAuth({ codexHome, env = process.env, log: logger = log } = {}) {
  if (codexHome) {
    try {
      const parsed = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
      if (parsed && typeof parsed === "object" && "tokens" in parsed) {
        return { ok: true, reason: null };
      }
    } catch {
      /* absent / unparseable — fall through to the CODEX_API_KEY / fail rungs */
    }
  }
  if (env.CODEX_API_KEY) {
    // LOUD: metered api-key mode is NOT the subscription auth — bill-per-token.
    // Log the MODE only; never the key value.
    try {
      logger?.warn?.(
        "codex-exec: CODEX_API_KEY is set — running in METERED api-key mode (billed per token), " +
          "NOT the subscription ChatGPT auth. Unset it and `codex login` for subscription auth.",
      );
    } catch {
      /* logging must never break a dispatch */
    }
    return { ok: true, reason: null };
  }
  const home = codexHome || "<codexHome>";
  return {
    ok: false,
    reason:
      `codex auth missing — no ${join(home, "auth.json")} with a \`tokens\` key and CODEX_API_KEY is unset. ` +
      `Authenticate this worker home with \`CODEX_HOME=${home} codex login\` ` +
      `(one interactive login per home — never copy auth.json between homes: OpenAI single-use refresh-token rotation would exhaust the fork).`,
  };
}

// defaultCheckCodexBinary — the boot-eligibility binary probe: `codex --version`
// must exit 0. Catches the missing-vendor-binary failure mode (an unprovisioned
// node whose `codex` is absent / not on PATH). Best-effort — any spawn error is a
// non-runnable verdict. Injectable via resolveCodexBootEligibility's `checkBinary`.
function defaultCheckCodexBinary(cfg, env = process.env) {
  try {
    const res = spawnSync(cfg.bin, ["--version"], {
      encoding: "utf8",
      env,
      timeout: 10000,
      killSignal: "SIGKILL",
    });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

// resolveCodexBootEligibility — the daemon-boot gate for codex routing (CTL-1457),
// mirroring resolveSdkBootExecutor's STYLE (a boot-time precondition check that
// WARN-logs + emits an observability event on failure). Called ONCE at daemon boot
// with the Layer-1 executorByPhase map AND the resolved boot executor.
//   - When NOTHING routes to codex-exec (no executorByPhase value canonicalizes to
//     codex-exec AND the boot executor is not codex-exec): return { eligible:true }
//     with NO auth check, NO binary probe, and NO event — a pure no-op (the common
//     case; codex routing is defaulted-empty). This is what keeps a pure-Claude
//     node's boot byte-identical to today.
//   - When codex is routed — either a per-phase route OR the node-level boot executor
//     is itself codex-exec (finding 1: a codex-exec node runs EVERY phase on codex
//     even with an empty map, so it must be gated too): assert auth AND probe the
//     binary. Both ok → { eligible:true }. Else → WARN-log LOUDLY, best-effort emit
//     execution-core.executor.codex-fallback, and return { eligible:false, reason }.
//     makePhaseAwareDispatchFn degrades routed codex phases, and daemon.mjs degrades
//     the node-level boot executor, to a concrete non-codex fallback.
// The daemon threads the result's `eligible` into makePhaseAwareDispatchFn's
// codexBootEligible; the phase-level degrade decision lives there, the node-level one
// in daemon.mjs. `bootExecutor` both ARMS the gate (when === codex-exec) and labels
// the event's `effective` field with the REAL degrade target (finding 5): "bg" for a
// node-level codex node (falling back to codex-exec would loop), else the actual boot
// executor (e.g. "sdk"); defaults to "bg" when unset. NOTE: no compound alias
// currently resolves TO codex-exec (config.mjs EXECUTOR_ALIASES maps only claude-* →
// bg/sdk/oneshot-legacy), so a case-normalized === "codex-exec" IS the post-alias test.
export function resolveCodexBootEligibility(
  executorByPhase,
  {
    codexCfg,
    env = process.env,
    assertAuth = assertCodexAuth,
    checkBinary,
    emitEvent,
    bootExecutor,
    log: logger = log,
  } = {},
) {
  // finding 1: the node-level boot executor being codex-exec ALSO arms the gate — a
  // node whose default executor is codex-exec routes EVERY phase to codex even with an
  // empty executorByPhase, so its auth/binary must be checked at boot.
  const bootRoutesToCodex =
    typeof bootExecutor === "string" && bootExecutor.trim().toLowerCase() === CODEX_EXECUTOR_ID;
  const phaseRoutesToCodex =
    executorByPhase && typeof executorByPhase === "object"
      ? Object.values(executorByPhase).some(
          (v) => typeof v === "string" && v.trim().toLowerCase() === CODEX_EXECUTOR_ID,
        )
      : false;
  const routesToCodex = bootRoutesToCodex || phaseRoutesToCodex;
  // Nothing routed to codex → no gate at all (no checks, no event).
  if (!routesToCodex) return { eligible: true, reason: null };

  const cfg = codexCfg ?? codexConfig({ env });
  const check = checkBinary ?? (() => defaultCheckCodexBinary(cfg, env));

  let reason = null;
  const auth = assertAuth({ codexHome: cfg.codexHome, env });
  if (!auth.ok) {
    reason = auth.reason;
  } else {
    let binOk = false;
    try {
      binOk = check() === true;
    } catch {
      binOk = false;
    }
    if (!binOk) {
      reason = `codex binary '${cfg.bin}' is not runnable (\`${cfg.bin} --version\` did not exit 0) — provision/PATH the codex CLI on this node`;
    }
  }
  if (!reason) return { eligible: true, reason: null };

  if (logger?.warn) {
    try {
      logger.warn(
        { reason },
        "execution-core: executorByPhase routes a phase to codex-exec but the codex boot precondition FAILED — degrading routed codex phases to the boot executor (fix auth/binary and restart to arm codex-exec)",
      );
    } catch {
      /* logging must never break boot */
    }
  }
  if (emitEvent) {
    try {
      emitEvent({
        "event.name": "execution-core.executor.codex-fallback",
        // finding 5: report the REAL degrade target — "bg" for a node-level codex node
        // (bootExecutor is itself codex-exec, so degrading TO it would loop), else the
        // actual boot executor (e.g. "sdk"); "bg" when bootExecutor is unset.
        payload: {
          requested: CODEX_EXECUTOR_ID,
          effective: bootRoutesToCodex ? "bg" : bootExecutor ?? "bg",
          reason,
        },
      });
    } catch {
      /* best-effort */
    }
  }
  return { eligible: false, reason };
}

// resolveDevPluginRoot — the dev plugin's checkout dir from the launch spec's
// pluginDirs (entries point at `<checkout>/plugins/dev`). Prefer the entry whose
// leaf is the dev plugin; fall back to the first non-empty entry. undefined when
// pluginDirs is empty. Used for CLAUDE_PLUGIN_ROOT + the skills symlink source.
function resolveDevPluginRoot(pluginDirs) {
  if (!Array.isArray(pluginDirs) || pluginDirs.length === 0) return undefined;
  const dev = pluginDirs.find(
    (p) => typeof p === "string" && (basename(p) === "dev" || /(?:^|\/)plugins\/dev\/?$/.test(p)),
  );
  if (dev) return dev;
  return pluginDirs.find((p) => typeof p === "string" && p.length > 0);
}

// resolveThoughtsRoot — the REAL path the worktree's `thoughts/` symlink points
// to (it points OUTSIDE the workspace — see the protocol doc). Added to the
// writable roots so codex can write research/plan artifacts under thoughts/.
// null when there is no thoughts symlink (best-effort — never throws).
function resolveThoughtsRoot(worktreePath) {
  if (!worktreePath) return null;
  try {
    return realpathSync(join(worktreePath, "thoughts"));
  } catch {
    return null;
  }
}

// resolveWritableRoots — the de-duplicated, absolute writable-root set for the
// `-c sandbox_workspace_write.writable_roots=[…]` override: the configured roots
// ∪ {orchDir} ∪ {the resolved thoughts real-root of the worktree if present}.
// Order-preserving; drops non-absolute / empty / duplicate entries.
function resolveWritableRoots(cfg, { orchDir, worktreePath } = {}) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (typeof p === "string" && p.length > 0 && isAbsolute(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const r of cfg?.writableRoots ?? []) add(r);
  add(orchDir);
  add(resolveThoughtsRoot(worktreePath));
  return out;
}

// buildCodexPrompt — render the phase-skill invocation + a harness shim from the
// spec's pre-rendered slash command (D10: `spec.prompt` is ONE string, e.g.
// "/catalyst-dev:phase-triage CTL-123 --orch-dir /x"). Extracts the skill
// short-name (phase-triage) + the argument tail, then appends the SHIM paragraph
// that steers the non-Claude Codex worker away from the skill's Claude-only
// constructs and onto the terminal emit. If parsing fails, the raw prompt rides
// verbatim + the shim. Pure. Snapshot-tested.
export function buildCodexPrompt(spec) {
  const raw = typeof spec?.prompt === "string" ? spec.prompt : "";
  const shim = harnessShim();
  const m = raw.match(/^\/(?:[\w-]+:)?([\w-]+)\s*([\s\S]*)$/);
  if (!m) {
    return `${raw}\n\n${shim}`;
  }
  const skill = m[1];
  const args = m[2].trim();
  const invocation = args
    ? `Use the \`${skill}\` skill (catalyst-dev plugin). Arguments: ${args}.`
    : `Use the \`${skill}\` skill (catalyst-dev plugin).`;
  return `${invocation}\n\n${shim}`;
}

function harnessShim() {
  return [
    "Execution-harness notes (you are running as a non-Claude Codex worker, not Claude Code):",
    "- SKIP the skill's `## /goal` self-evaluation section entirely — it is a Claude-only self-scoring step that does not apply to you.",
    "- Do NOT run the skill's `claude stop` self-halt command — there is no Claude background job to stop; omit that step.",
    "- ALWAYS finish by running the skill's terminal `phase-agent-emit-complete` step EXACTLY as written. It writes the phase signal file and appends the canonical completion event — the ONLY completion signal the daemon reads. If you skip it the ticket stalls forever.",
  ].join("\n");
}

// buildCodexArgs — the exact `codex exec --json` argv. The prompt (buildCodexPrompt)
// is the LAST positional. writable_roots is JSON.stringified (a valid TOML string
// array that survives spaces in paths). `-m <model>` is added ONLY when cfg.model
// is non-null (per the Phase 1 codexConfig default — we never invent a model id).
//
// CTL-1457 (T6): for a boot-resume/revive dispatch (spec.resumeSession set) build the
// RESUME subcommand form so codex continues the interrupted thread instead of starting
// a fresh one (which duplicates work on restart). Per the codex protocol §A
// (`codex exec [OPTIONS] <COMMAND> [ARGS]`, COMMAND ∈ {resume, review};
// `codex exec resume <SESSION_ID>`): the session id is the `resume` subcommand's
// positional; the (global) --json / sandbox / -c overrides / -m still apply after it,
// and the prompt stays the last positional. Absent resumeSession → the fresh
// `exec --json …` form, byte-identical to before.
export function buildCodexArgs(spec, cfg, { orchDir, worktreePath } = {}) {
  const roots = resolveWritableRoots(cfg, { orchDir, worktreePath });
  const prompt = buildCodexPrompt(spec);
  const resume = spec?.resumeSession;
  const head = resume ? ["exec", "resume", String(resume)] : ["exec"];
  return [
    ...head,
    "--json",
    "--sandbox",
    "workspace-write",
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    "-c",
    "sandbox_workspace_write.network_access=true",
    ...(cfg?.model ? ["-m", cfg.model] : []),
    prompt,
  ];
}

// buildCodexEnv — the env handed to the codex child. Base process.env, then the
// spec's env array (KEY=VALUE strings: CATALYST_* + fencing token + OTEL attrs)
// verbatim, then CODEX_HOME / CLAUDE_PLUGIN_ROOT / CATALYST_EXECUTOR_ID. The KEY
// divergence from buildSdkEnv: it DELETES CLAUDE_CODE_OAUTH_TOKEN too (plus the
// ANTHROPIC_* keys) — codex must NOT carry the Claude subscription token. All
// CATALYST_* from the spec env are preserved (only the three vendor-auth vars are
// stripped).
export function buildCodexEnv(spec, cfg) {
  const env = { ...process.env };
  for (const kv of spec?.env ?? []) {
    const s = String(kv);
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    env[s.slice(0, idx)] = s.slice(idx + 1);
  }
  if (cfg?.codexHome) env.CODEX_HOME = cfg.codexHome;
  // CTL-1457 (T4): prefer the resolved codex.pluginRoot (CATALYST_CODEX_PLUGIN_ROOT /
  // Layer-1 codex.pluginRoot) over the launch spec's pluginDirs. A node with the
  // override — or with empty/stale pluginDirs — must still point CLAUDE_PLUGIN_ROOT at
  // the catalyst skills, else codex launches without them. Falls back to pluginDirs
  // when cfg.pluginRoot is unset (the common case), so unrouted nodes are unchanged.
  const pluginRoot = cfg?.pluginRoot ?? resolveDevPluginRoot(spec?.pluginDirs);
  if (pluginRoot) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  env.CATALYST_EXECUTOR_ID = CODEX_EXECUTOR_ID;
  // Wrong-vendor leakage guard: codex authenticates via CODEX_HOME/CODEX_API_KEY,
  // NEVER the Claude subscription token. Strip all three Claude-auth vars.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

// gitExcludeAgents — append `.agents/` to the worktree's git info/exclude so the
// codex skills symlink never shows as an untracked file (D7 — net-new; no existing
// pattern). Handles the worktree `.git` being a FILE pointing at the real gitdir
// by asking git for the resolved path. Idempotent + best-effort — never throws.
function gitExcludeAgents(worktreePath) {
  const pattern = ".agents/";
  let excludePath = null;
  try {
    const res = spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
    });
    if (res && res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
      const rel = res.stdout.trim();
      excludePath = isAbsolute(rel) ? rel : join(worktreePath, rel);
    }
  } catch {
    /* fall through to the manual resolver */
  }
  if (!excludePath) excludePath = resolveGitInfoExcludeFallback(worktreePath);
  if (!excludePath) return;
  try {
    let existing = "";
    try {
      existing = readFileSync(excludePath, "utf8");
    } catch {
      /* no exclude file yet */
    }
    const present = existing
      .split("\n")
      .map((l) => l.trim())
      .some((l) => l === pattern || l === ".agents" || l === "/.agents/" || l === "/.agents");
    if (present) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
  } catch {
    /* best-effort */
  }
}

// resolveGitInfoExcludeFallback — manual info/exclude resolution when `git` is
// unavailable. `.git` a dir → <wt>/.git/info/exclude; `.git` a file → parse
// `gitdir: <path>` and use <gitdir>/info/exclude. null when neither resolves.
function resolveGitInfoExcludeFallback(worktreePath) {
  try {
    const dotGit = join(worktreePath, ".git");
    const st = lstatSync(dotGit);
    if (st.isDirectory()) return join(dotGit, "info", "exclude");
    if (st.isFile()) {
      const contents = readFileSync(dotGit, "utf8");
      const m = contents.match(/gitdir:\s*(.+)\s*/);
      if (m) {
        const gitdir = m[1].trim();
        const abs = isAbsolute(gitdir) ? gitdir : join(worktreePath, gitdir);
        return join(abs, "info", "exclude");
      }
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// ensureCodexSkills — symlink <worktreePath>/.agents/skills to the pristine
// dev-plugin skills dir so a Codex worker can discover the /catalyst-dev:phase-*
// skills (Codex reads `.agents/skills`, not Claude plugins), and git-exclude
// `.agents/` (D7). Best-effort — a resolution/link failure logs and returns; it
// never throws fatally (the runner calls it before spawn).
//
// CTL-1457 (T4): the skills source is cfg.pluginRoot when set (the resolved
// codex.pluginRoot), else resolved from pluginDirs — the same precedence
// buildCodexEnv uses for CLAUDE_PLUGIN_ROOT so both point at the SAME skills.
//
// CTL-1457 (T7): NEVER `rm -r` a path this runner does not own. Phase workers run in
// ARBITRARY project worktrees, so a pre-existing `.agents/skills` may be the project's
// or user's real Codex skills (a real dir) or a foreign symlink — the old unlink-first
// setup deleted it (DATA LOSS). Only touch the link when SAFE:
//   - ABSENT               → create our symlink;
//   - OUR symlink (→ src)  → idempotent no-op;
//   - real dir / FOREIGN symlink → leave it untouched, WARN LOUDLY, and skip.
export function ensureCodexSkills(worktreePath, { pluginDirs, pluginRoot, log: logger = log } = {}) {
  try {
    if (!worktreePath) return;
    const devRoot = pluginRoot ?? resolveDevPluginRoot(pluginDirs);
    if (!devRoot) return;
    const skillsSrc = join(devRoot, "skills");
    const agentsDir = join(worktreePath, ".agents");
    const skillsLink = join(agentsDir, "skills");
    mkdirSync(agentsDir, { recursive: true });
    // Probe the existing entry WITHOUT removing anything.
    let existing = null;
    try {
      existing = lstatSync(skillsLink);
    } catch {
      /* absent — fall through to create our symlink */
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        let target = null;
        try {
          target = readlinkSync(skillsLink);
        } catch {
          /* unreadable link — treat as foreign, never clobber */
        }
        if (target === skillsSrc) {
          // OUR symlink already in place — idempotent no-op (still ensure the exclude).
          gitExcludeAgents(worktreePath);
          return;
        }
      }
      // A real directory OR a symlink pointing at something ELSE — this runner does
      // NOT own it. Leave it exactly as-is and skip (best-effort, non-fatal).
      try {
        logger?.warn?.(
          { worktreePath, skillsLink, wanted: skillsSrc },
          "codex-exec: .agents/skills already exists and is not our symlink — leaving it untouched (skipping codex skills setup; codex may not discover the phase skills)",
        );
      } catch {
        /* logging must never break a dispatch */
      }
      return;
    }
    symlinkSync(skillsSrc, skillsLink);
    gitExcludeAgents(worktreePath);
  } catch (err) {
    try {
      logger?.warn?.(
        { worktreePath, err: err?.message },
        "codex-exec: ensureCodexSkills best-effort setup failed",
      );
    } catch {
      /* logging must never break a dispatch */
    }
  }
}

// ── JSONL classification ──────────────────────────────────────────────────────
// classifyCodexOutcome — gate on the EXIT CODE first (findings 2+3). A run that
// exits 0 with no `turn.failed` is a SUCCESS, even if a NON-FATAL `error` notice
// (e.g. a transient "high demand" / "at capacity" warning the run recovered from,
// or an auth-refresh message on a token the run then re-used successfully) left an
// errMsg behind — string-matching those on a clean run would WRONGLY park a shipped
// phase. Only when the run actually FAILED (non-zero exit, or a real `turn.failed`)
// do we classify from the error message string: codex exec exits 1 for auth failure,
// usage-limit, and generic failure alike (exit code can't distinguish them — protocol
// §C/§D), and auth-park (needs re-login) OUTRANKS rate-park, which outranks generic
// failed. `aborted` is handled by the runner BEFORE this is called.
function classifyCodexOutcome({ exitCode, errMsg, stderrTail, turnFailed }) {
  if (exitCode === 0 && !turnFailed) return "success";
  const hay = `${errMsg ?? ""}\n${stderrTail ?? ""}`.toLowerCase();
  if (/refresh_token_reused|refresh token|log out and sign in again/.test(hay)) {
    return "auth-park";
  }
  if (/usage limit|quota exceeded|out of credits|spend cap|at capacity|high demand/.test(hay)) {
    return "rate-park";
  }
  return "failed";
}

// normalizeUsage — the flat 4-field codex `turn.completed` usage, numerically
// coerced (missing/non-numeric → 0). null when there is no usage object.
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input_tokens: num(usage.input_tokens),
    cached_input_tokens: num(usage.cached_input_tokens),
    output_tokens: num(usage.output_tokens),
    reasoning_output_tokens: num(usage.reasoning_output_tokens),
  };
}

// readSignalStatus — the current on-disk phase-signal status (or null when the
// file is absent/unreadable). Used to gate the generic-failure backstop to a
// still-in-flight (dispatched/running) signal.
function readSignalStatus(signalFile) {
  if (!signalFile) return null;
  try {
    const sig = JSON.parse(readFileSync(signalFile, "utf8"));
    return sig && typeof sig === "object" ? String(sig.status ?? "") : null;
  } catch {
    return null;
  }
}

// spawnAndParse — spawn ONE codex-exec child, line-buffer its stdout JSONL, and
// resolve a structured outcome once it closes (or errors). Cancellation is BOTH
// AbortController-cooperative (the `signal` option node passes to the child) AND
// an explicit child.kill("SIGTERM") + SIGKILL escalation (an AbortController
// alone cannot stop a subprocess). Never rejects — every failure resolves a
// structured record so the runner's control flow stays linear.
function spawnAndParse({ bin, args, cwd, env, spawnChild, reg, onSession, secrets, killGraceMs = 2000 }) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    reg.setAbortController?.(ac);

    let child;
    try {
      child = spawnChild(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"], // stdin IGNORED — the mandatory </dev/null stdin-hang fix
        env,
        signal: ac.signal, // node SIGTERMs the child on abort (belt); onAbort is the suspenders
      });
    } catch (err) {
      resolve({
        exitCode: 127,
        signal: null,
        aborted: false,
        spawnError: err,
        usage: null,
        errMsg: null,
        stderrTail: scrubSecrets(String(err?.message ?? err), secrets),
      });
      return;
    }

    let settled = false;
    let aborted = false;
    let killTimer = null;
    let usage = null;
    let errMsg = null;
    let turnFailed = false; // a real `turn.failed` — distinct from a non-fatal `error` notice (findings 2+3)
    let stdoutBuf = "";
    const stderrTailLines = [];

    const cleanup = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      try {
        ac.signal.removeEventListener("abort", onAbort);
      } catch {
        /* older runtimes */
      }
    };
    const tail = () => scrubSecrets(stderrTailLines.join("\n"), secrets);
    const finish = (res) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    function onAbort() {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      // SIGKILL escalation if the child ignores SIGTERM. CTL-1457 (T3): this timer
      // MUST outlive the AbortError 'error' event — see the child.on("error") handler
      // — so a child that ignores SIGTERM is still force-killed and the aborted path
      // only settles once the child has actually CLOSED. Cleared by cleanup() on the
      // real 'close' (by which point the child is dead or the kill has fired).
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, killGraceMs);
      if (killTimer && typeof killTimer.unref === "function") killTimer.unref();
    }
    try {
      ac.signal.addEventListener("abort", onAbort, { once: true });
    } catch {
      /* older runtimes — the node `signal` option still fires */
    }

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return; // non-JSON (stray line) — ignore
      }
      switch (obj?.type) {
        case "thread.started":
          if (typeof obj.thread_id === "string" && obj.thread_id) onSession(obj.thread_id);
          break;
        case "item.started":
        case "item.updated":
          reg.touch?.();
          break;
        case "item.completed":
          reg.touch?.();
          // item.type === "error" is a NON-FATAL notice (skills-budget, warnings) — ignore.
          break;
        case "turn.completed":
          if (obj.usage && typeof obj.usage === "object") usage = obj.usage; // last wins
          break;
        case "turn.failed":
          turnFailed = true; // a genuine turn failure (findings 2+3) — never a success
          if (obj?.error?.message) errMsg = obj.error.message;
          break;
        case "error":
          if (obj?.message) errMsg = obj.message;
          break;
        default:
          break;
      }
    };

    child.stdout?.on?.("data", (chunk) => {
      stdoutBuf += String(chunk);
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        processLine(line);
      }
    });

    child.stderr?.on?.("data", (chunk) => {
      const text = String(chunk);
      for (const l of text.split("\n")) {
        if (l.length) stderrTailLines.push(l);
      }
      while (stderrTailLines.length > 20) stderrTailLines.shift(); // keep the last ~20
    });

    child.on("error", (err) => {
      if (aborted || err?.name === "AbortError") {
        // CTL-1457 (T3): Node's spawn({signal}) emits AbortError BEFORE the child
        // necessarily exits. Do NOT settle here — settling runs cleanup(), which
        // clears the SIGKILL escalation timer, so a child that ignores SIGTERM would
        // survive (deregistered + slot released while still running). Return and let
        // the 'close' handler settle the aborted outcome once the child has ACTUALLY
        // exited (SIGTERM worked, or onAbort's killTimer escalated to SIGKILL).
        return;
      }
      finish({
        exitCode: 127,
        signal: null,
        aborted: false,
        spawnError: err,
        usage,
        errMsg,
        stderrTail: scrubSecrets(String(err?.message ?? err), secrets),
      });
    });

    child.on("close", (exitCode, signal) => {
      if (stdoutBuf.length) {
        processLine(stdoutBuf); // flush a trailing unterminated line
        stdoutBuf = "";
      }
      finish({ exitCode, signal, aborted, usage, errMsg, turnFailed, stderrTail: tail() });
    });
  });
}

// codexRunPhaseAgent — the executor=codex-exec launch verb. async (spawns the
// codex child and awaits its stream), returns the defaultRunPhaseAgent shape (+
// codex extras). Mirrors sdkRunPhaseAgent's control-flow ORDER: auth → prelaunch
// → env/args/prepare → register → semaphore → spawn/parse/classify → finally.
export async function codexRunPhaseAgent(
  { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
  {
    codexCfg,
    configPath,
    env = process.env,
    assertAuth = assertCodexAuth,
    spawn = spawnSync, // for runPrelaunch (the synchronous Stage-A pre-launch)
    spawnChild = defaultSpawnChild, // the async codex child spawn
    runPrelaunchFn = runPrelaunch,
    registerWorker = defaultRegisterSdkWorker,
    emitEvent = defaultEmitEvent,
    // eslint-disable-next-line no-unused-vars -- reserved for signature parity with the sdk path (codex has no context-% event)
    emitContextEvent,
    writeSignalStalled = defaultWriteSignalStalled,
    markLaunchFailed = defaultMarkLaunchFailed,
    prepareWorktree = ensureCodexSkills,
    semaphore,
    maxParallel = resolveMaxParallel(),
    sleep = defaultSleep,
    maxRateRetries = 2,
    killGraceMs = 2000, // CTL-1457 (T3): SIGTERM→SIGKILL abort grace (injectable for tests)
  } = {},
) {
  const cfg = codexCfg ?? codexConfig({ configPath, env });
  const secrets = [
    env.CODEX_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    env.CLAUDE_CODE_OAUTH_TOKEN,
  ].filter((s) => typeof s === "string" && s.length > 0);

  // ── AUTH GUARD: refuse BEFORE any side effect (no claim, no signal) ───────
  const auth = assertAuth({ codexHome: cfg.codexHome, env });
  if (!auth.ok) {
    emitEvent("execution-core.auth.misconfigured", {
      executor: CODEX_EXECUTOR_ID,
      ticket,
      phase,
      reason: auth.reason,
    });
    return { code: 1, stdout: "", stderr: auth.reason, signal: null };
  }

  // ── SHARED PRE-LAUNCH (claim + fenced "dispatched" signal + generation +
  //    rebase + prompt/env composition) via phase-agent-dispatch prelaunch-only ─
  const pre = runPrelaunchFn(
    { orchDir, ticket, phase, worktreePath, resumeSession, handoffPath, attempt, clusterGeneration },
    { spawn, executorId: CODEX_EXECUTOR_ID }, // CTL-1457: prelaunch writes executor:"codex-exec" into the signal file
  );
  if (pre.idempotent) {
    // A claim-lost / existing dispatched|running|done signal — the winner owns the
    // phase. No-op success (no query, no backstop).
    return { code: 0, stdout: "", stderr: "", signal: null };
  }
  if (!pre.ok) {
    // A prelaunch that died AFTER writing "dispatched" but BEFORE the spec leaves a
    // runnable signal — flip any still-in-flight signal to stalled so verify demotes
    // it to a dispatch failure (defaultWriteSignalStalled's P3 guard no-ops when the
    // signal is absent or already terminal).
    const failedSignalFile =
      pre.spec?.signalFile ?? join(orchDir, "workers", ticket, `phase-${phase}.json`);
    writeSignalStalled(failedSignalFile, "codex-prelaunch-failed");
    return {
      code: pre.code || 1,
      stdout: "",
      stderr: scrubSecrets(pre.stderr, secrets) || "codex: shared pre-launch failed (no launch spec)",
      signal: null,
    };
  }

  const spec = pre.spec;
  const signalFile = spec.signalFile;
  const wt = spec.worktreePath ?? worktreePath;
  const childEnv = buildCodexEnv(spec, cfg);
  const args2 = buildCodexArgs(spec, cfg, { orchDir, worktreePath: wt });

  // Symlink .agents/skills + git-exclude .agents/ before spawn (best-effort).
  // CTL-1457 (T4): pass cfg.pluginRoot so the skills source honors the same
  // codex.pluginRoot override CLAUDE_PLUGIN_ROOT uses (falls back to spec.pluginDirs).
  prepareWorktree(wt, { pluginDirs: spec.pluginDirs, pluginRoot: cfg.pluginRoot });

  // Register in the in-process worker registry (executor-tagged). Registered
  // BEFORE the semaphore so a parked worker still reads as live.
  const reg = registerWorker({
    ticket,
    phase,
    worktreePath: wt,
    generation: spec.generation,
    orchDir,
    sessionId: spec.resumeSession ?? null,
    executor: CODEX_EXECUTOR_ID,
  });

  const sem = semaphore ?? sharedSemaphore(maxParallel);
  const release = await sem.acquire();

  // The live codex thread id (resume key). Captured from thread.started; on a
  // rate-retry the new process starts a NEW thread — close the old id first.
  let sessionId = null;
  const onSession = (tid) => {
    if (!tid || tid === sessionId) return;
    if (sessionId) {
      emitEvent("worker.session.stopped", {
        ticket,
        phase,
        session_id: sessionId,
        generation: spec.generation ?? null,
      });
    }
    sessionId = tid;
    reg.setSessionId?.(sessionId);
    emitEvent(spec.resumeSession ? "worker.session.resumed" : "worker.session.started", {
      ticket,
      phase,
      session_id: sessionId,
      generation: spec.generation ?? null,
    });
  };

  try {
    for (let rateAttempt = 0; ; rateAttempt++) {
      const res = await spawnAndParse({
        bin: cfg.bin,
        args: args2,
        cwd: wt,
        env: childEnv,
        spawnChild,
        reg,
        onSession,
        secrets,
        killGraceMs,
      });

      // Abort — a cancelled child (preemption / watchdog). Surface aborted:true.
      if (res.aborted) {
        return {
          code: res.exitCode ?? 1,
          stdout: "",
          stderr: res.stderrTail ?? "",
          signal: "SIGTERM",
          aborted: true,
          usage: normalizeUsage(res.usage),
          sessionId,
        };
      }

      const classification = res.spawnError ? "failed" : classifyCodexOutcome(res);

      if (classification === "auth-park") {
        // STICKY needs-human path — a fresh `codex login` for this home is required.
        // Do NOT loop (a re-dispatch would just re-fail the same way).
        writeSignalStalled(signalFile, "codex-auth");
        emitEvent("execution-core.codex.auth-park", {
          ticket,
          phase,
          reason: scrubSecrets(res.errMsg ?? res.stderrTail ?? "", secrets),
        });
        return {
          code: 1,
          stdout: "",
          stderr: res.stderrTail ?? "",
          signal: res.signal ?? null,
          classification: "auth-park",
          sessionId,
        };
      }

      if (classification === "rate-park") {
        const exhausted = rateAttempt >= maxRateRetries;
        emitEvent("execution-core.codex.rate-park", { ticket, phase, attempt: rateAttempt, exhausted });
        if (!exhausted) {
          await sleep(rateBackoffMs(rateAttempt));
          continue; // transient — retry the spawn (bounded)
        }
        // Exhausted (CTL-1457 T1): mirror the sdk overloaded-exhausted backstop so a
        // TERMINAL signal is written AND the canonical phase.<phase>.failed.<ticket>
        // event is emitted. Without it the async (thenable) codex dispatch already
        // settled "successful" (verifyDispatched requireBgJob:false) while recovery
        // no-ops a no-bg_job_id in-flight signal as "unknown" — the phase would stay
        // dispatched/running FOREVER, never entering cool-down. status:"failed" (NOT the
        // sticky needs-human auth-park path above) routes through the daemon's cool-down
        // / circuit-breaker retry — the scheduler re-dispatches after the cool-down,
        // which is the TRANSIENT behavior rate-park intends. Classification stays
        // "rate-park" for any caller that inspects it.
        markLaunchFailed(
          { phase, ticket, status: "failed", reason: "codex-rate-park-exhausted", orchDir, signalFile },
          { spawn },
        );
        return {
          code: 1,
          stdout: "",
          stderr: res.stderrTail ?? "",
          signal: res.signal ?? null,
          classification: "rate-park",
          sessionId,
        };
      }

      if (classification === "failed") {
        // Mark the still-in-flight signal failed (mirror the sdk backstop) so the
        // terminal sweep reclaims it. A skill that wrote its own terminal status
        // already advanced — don't clobber it.
        const status = readSignalStatus(signalFile);
        if (status === "dispatched" || status === "running") {
          markLaunchFailed(
            { phase, ticket, status: "failed", reason: "codex-failed", orchDir, signalFile },
            { spawn },
          );
        }
        return {
          code: res.exitCode || 1,
          stdout: "",
          stderr: res.stderrTail ?? "",
          signal: res.signal ?? null,
          classification: "failed",
          usage: normalizeUsage(res.usage),
          sessionId,
        };
      }

      // success (exitCode === 0) — in-process backstop flip (no-op when the skill's
      // own phase-agent-emit-complete already flipped it, or the generation is stale).
      flipSignalDoneOnSuccess(signalFile, spec.generation);
      const usage = normalizeUsage(res.usage);
      emitEvent("execution-core.codex.phase-turns", { ticket, phase, usage });
      return {
        code: 0,
        stdout: "",
        stderr: res.stderrTail ?? "",
        signal: res.signal ?? null,
        classification: "success",
        usage,
        sessionId,
      };
    }
  } finally {
    // Lifecycle close: started/resumed without a stopped is the interrupted-session
    // shape, so stopped must fire on EVERY post-capture exit path.
    if (sessionId) {
      emitEvent("worker.session.stopped", {
        ticket,
        phase,
        session_id: sessionId,
        generation: spec.generation ?? null,
      });
    }
    reg.deregister?.();
    release();
  }
}
