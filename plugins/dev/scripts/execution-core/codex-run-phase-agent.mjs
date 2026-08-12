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
// scrubSecrets (token redaction), flipSignalDoneOnSuccess (the clean-exit
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
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
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

// PROVISIONED_THOUGHTS_ENTRIES — the only immediate `thoughts/` entry names
// lib/provision-thoughts.sh ever creates as symlinks (see its `globalDir:
// "global"` / shared-dir provisioning). resolveThoughtsRoots enumerates ONLY
// these — never every symlink an attacker (or a prior compromised codex turn,
// which already has write access to its OWN worktree, including thoughts/)
// could plant under thoughts/ with an arbitrary name (e.g. `thoughts/root`).
const PROVISIONED_THOUGHTS_ENTRIES = new Set(["shared", "global"]);

// THOUGHTS_GLOBAL_DIR_NAME — the exact subdirectory name `thoughts/global`
// must resolve to under a config-validated THOUGHTS_REPO anchor. Hardcoded
// to match lib/provision-thoughts.sh's write_config, which itself always
// writes `globalDir: "global"` (a literal, not derived from anything) —
// the same constant the local entry name `global` already encodes.
const THOUGHTS_GLOBAL_DIR_NAME = "global";

// isSaneThoughtsTarget — the resolved target of a thoughts/ symlink must not
// be the filesystem root or a bare top-level directory (`/`, `/etc`, `/Users`,
// …). Every legitimate thoughts-repo target nests at least one level below a
// real checkout (e.g. `/Users/x/thoughts/repos/proj/shared`,
// `/home/x/thoughts-repo/global`) — a resolved depth of 0–1 is exactly the
// shape a malicious `thoughts/shared -> /` (or `-> /etc`) symlink produces,
// and is the concrete cross-run sandbox-escape vector this guards against:
// codex's own worktree writes are already sandboxed to the worktree, so
// planting such a symlink costs an attacker nothing, but a FUTURE dispatch's
// resolveWritableRoots would otherwise hand that resolved path (up to `/`
// itself) real filesystem write access.
//
// 2026-08-07 P1 follow-up (Codex round-3, PR #3082): a bare segment-count
// floor alone is NOT sufficient — `thoughts/shared -> /home/alice` (or any
// other 2+-segment path an attacker chooses) still passes a `>= 2` (or even
// a raised `>= 3`) check while granting write access to an arbitrary,
// unrelated directory. The real, structural defense is
// resolveConfiguredThoughtsAnchor below: validate the resolved target
// against the WORKTREE'S OWN configured thoughts repository (the same
// `.catalyst/config.json` → `catalyst.thoughts.directory` source of truth
// lib/assert-thoughts-project.sh already uses for exactly this purpose), not
// a shape heuristic. isSaneThoughtsTarget is kept ONLY as a last-resort
// structural floor for the legacy direct-symlink shape and as a fallback
// when a worktree genuinely has no thoughts config to validate against
// (fail-open, mirroring assert-thoughts-project.sh's own precedent) — it is
// no longer the primary guard for the common `shared`/`global` shape.
function isSaneThoughtsTarget(p) {
  if (typeof p !== "string" || !isAbsolute(p)) return false;
  const segments = p.split("/").filter(Boolean);
  return segments.length >= 2;
}

// resolveConfiguredThoughtsDirectory — reads the SAME field
// lib/assert-thoughts-project.sh validates thoughts/shared against:
// `.catalyst/config.json` → `catalyst.thoughts.directory`, from the worktree
// root. Returns null (not an empty string) when the file is missing,
// unparsable, or the field is absent — the caller treats null as "no
// authoritative anchor available" and falls back to the structural check,
// same fail-open precedent as assert-thoughts-project.sh.
function resolveConfiguredThoughtsDirectory(worktreePath) {
  if (!worktreePath) return null;
  try {
    const cfg = JSON.parse(readFileSync(join(worktreePath, ".catalyst", "config.json"), "utf8"));
    const dir = cfg?.catalyst?.thoughts?.directory;
    return typeof dir === "string" && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

// resolveConfiguredThoughtsAnchor — validates a resolved `thoughts/shared`
// target against the worktree's configured thoughts directory, requiring the
// SAME `/repos/<directory>/` segment lib/assert-thoughts-project.sh requires
// (the two checks are independent implementations of the identical contract
// on purpose — one shell, one JS — not a shared function call). On a match,
// derives and returns the THOUGHTS_REPO root (everything before that
// segment) so the sibling `thoughts/global` target — always
// `<THOUGHTS_REPO>/<globalDir>` per lib/provision-thoughts.sh /
// worktree-thoughts-init.sh — can be validated as nested under that SAME,
// now-trusted root rather than trusted independently. Returns null when
// there is no configured directory to check (fail-open — caller falls back
// to isSaneThoughtsTarget) OR when a configured directory is present but the
// resolved target does NOT contain the expected segment (fail-CLOSED — a
// declared, non-matching directory is a genuine mismatch, not an absence,
// and the caller must reject the target outright rather than fall back).
function resolveConfiguredThoughtsAnchor(worktreePath, resolvedSharedTarget) {
  const directory = resolveConfiguredThoughtsDirectory(worktreePath);
  if (!directory) return { anchor: null, mismatch: false };
  const expectedSegment = `/repos/${directory}/`;
  const idx = resolvedSharedTarget.indexOf(expectedSegment);
  if (idx === -1) return { anchor: null, mismatch: true };
  return { anchor: resolvedSharedTarget.slice(0, idx), mismatch: false };
}

// resolveThoughtsRoots — the REAL path(s) any symlink under the worktree's
// `thoughts/` points to (they point OUTSIDE the workspace — see the protocol
// doc). Added to the writable roots so codex can write research/plan artifacts
// under thoughts/. Best-effort throughout: a missing thoughts/ dir, an
// unreadable directory, or a broken/dangling symlink is skipped rather than
// thrown — never lets a sandbox-roots computation crash a dispatch.
//
// 2026-08-03 fix: the ACTUAL on-disk convention (lib/provision-thoughts.sh) is
// NOT "thoughts is a symlink" — it's "thoughts is a REAL directory whose
// immediate entries (`global`, `shared`) are themselves symlinks pointing
// outside the worktree." The prior version only ever `realpathSync`'d the
// `thoughts` directory itself; since `thoughts` isn't a symlink in that shape,
// that just returned the unchanged worktree-local path and never added the
// actual external target at all. Confirmed live: this silently broke every
// research/plan artifact write for codex-exec-routed phases (4+ real tickets,
// each failing with a "thoughts/shared symlink target outside writable roots"
// sandbox denial) — the bug had existed since codex-exec's original CTL-1457
// build (2026-07-14) with zero test coverage on this function, only surfacing
// once research/plan started getting routed through codex-exec.
//
// 2026-08-07 hardening (round-2 review, PR #3082): both shapes below are now
// gated by isSaneThoughtsTarget — see its comment for the sandbox-escape
// scenario this closes.
//
// 2026-08-07 hardening, round 2 (round-3 review, same PR): a bare structural
// floor alone was insufficient (any attacker-chosen 2+-segment path still
// passed). The real-directory shape below now validates `shared`/`global`
// against the worktree's CONFIGURED thoughts directory when one is declared
// — see resolveConfiguredThoughtsAnchor's doc comment — falling back to the
// structural floor only when no thoughts directory is configured at all.
//
// Handles BOTH shapes: `thoughts` itself being a symlink (the legacy/simple
// case this function originally assumed), and `thoughts` being a real
// directory whose entries are symlinks (the actual, far more common shape).
function resolveThoughtsRoots(worktreePath) {
  if (!worktreePath) return [];
  const thoughtsPath = join(worktreePath, "thoughts");
  let stat;
  try {
    stat = lstatSync(thoughtsPath);
  } catch {
    return [];
  }
  // Legacy/simple shape: `thoughts` itself is a symlink straight to the target.
  // 2026-08-07 hardening, round 3 (round-4 review, same PR): this branch used
  // to return early on the bare structural floor ONLY, skipping the
  // configured-directory validation entirely — a `thoughts -> /home/alice`
  // symlink (2 segments) passed the same way the real-directory shape's
  // `shared`/`global` used to before round 2's fix. Apply the SAME
  // CONFIGURED/UNCONFIGURED regime choice used below for `shared`.
  if (stat.isSymbolicLink()) {
    try {
      const real = realpathSync(thoughtsPath);
      const directory = resolveConfiguredThoughtsDirectory(worktreePath);
      if (directory) {
        // CONFIGURED regime — same `/repos/<directory>/` segment contract as
        // resolveConfiguredThoughtsAnchor, applied directly (no `global`
        // sibling to anchor here, so no separate anchor derivation needed).
        return real.includes(`/repos/${directory}/`) ? [real] : [];
      }
      // UNCONFIGURED regime — structural floor only (fail-open).
      return isSaneThoughtsTarget(real) ? [real] : [];
    } catch {
      return [];
    }
  }
  if (!stat.isDirectory()) return [];
  // Real-directory shape: resolve ONLY the provisioned entries (`global`,
  // `shared` — see PROVISIONED_THOUGHTS_ENTRIES) that are themselves symlinks,
  // to their real target. A real (non-symlink) entry, e.g. thoughts/searchable,
  // is left alone — it's already inside the worktree and needs no additional
  // writable root. Any OTHER symlinked entry (unprovisioned name) is skipped
  // outright, never resolved.
  //
  // `shared` is resolved FIRST (fixed iteration order below, not readdir
  // order) so its config-validated target can anchor `global`'s validation —
  // see resolveConfiguredThoughtsAnchor's doc comment.
  //
  // Two DISTINCT validation regimes, chosen ONCE by whether this worktree
  // declares a thoughts directory at all (`configuredDirectory`, read once
  // up front — not re-derived per entry):
  //   - CONFIGURED (the common case for every catalyst-managed worktree):
  //     `shared` must match the declared `/repos/<directory>/` segment or is
  //     rejected outright (fail-CLOSED — a declared, non-matching directory
  //     is a genuine mismatch). `global` must nest under THAT validated
  //     anchor or is likewise rejected outright — no structural fallback for
  //     either entry once a directory is declared, since a fixed segment
  //     count alone is exactly the insufficient guard Codex's round-3 finding
  //     flagged (an attacker-chosen 2+-segment target still passes a bare
  //     length check).
  //   - UNCONFIGURED (no `.catalyst/config.json` thoughts directory at all):
  //     nothing to validate against — fall back to the structural floor
  //     (isSaneThoughtsTarget) independently for each entry, the same
  //     fail-open precedent lib/assert-thoughts-project.sh already sets for
  //     an unconfigured project.
  const out = [];
  let entries;
  try {
    entries = new Set(readdirSync(thoughtsPath));
  } catch {
    return [];
  }
  const configuredDirectory = resolveConfiguredThoughtsDirectory(worktreePath);
  let anchor = null; // THOUGHTS_REPO root, once `shared` validates against config
  for (const entry of ["shared", "global"]) {
    if (!entries.has(entry) || !PROVISIONED_THOUGHTS_ENTRIES.has(entry)) continue;
    const entryPath = join(thoughtsPath, entry);
    try {
      if (!lstatSync(entryPath).isSymbolicLink()) continue;
      const real = realpathSync(entryPath);
      if (!configuredDirectory) {
        // UNCONFIGURED regime — structural floor only, no anchor tracking.
        if (isSaneThoughtsTarget(real)) out.push(real);
        continue;
      }
      // CONFIGURED regime — anchor-only, no structural fallback.
      if (entry === "shared") {
        const { anchor: derived } = resolveConfiguredThoughtsAnchor(worktreePath, real);
        if (derived) {
          anchor = derived;
          out.push(real);
        }
        // else: declared directory present but `shared`'s target doesn't
        // contain the expected segment — reject outright, `anchor` stays null.
      } else if (anchor && real === join(anchor, THOUGHTS_GLOBAL_DIR_NAME)) {
        out.push(real);
        // 2026-08-07 hardening, round 3 (round-4 review, same PR): "nested
        // under the anchor" (real===anchor || startsWith(anchor+"/")) was too
        // permissive — it accepted `global` re-pointed at the anchor ITSELF
        // (granting the whole THOUGHTS_REPO, every project under repos/) or
        // any other descendant. worktree-thoughts-init.sh:57-77 provisions
        // `global` as the EXACT `<THOUGHTS_REPO>/<globalDir>` target (and
        // lib/provision-thoughts.sh's write_config hardcodes globalDir to
        // the literal "global" — see THOUGHTS_GLOBAL_DIR_NAME), so require
        // that exact path, not merely "somewhere under the anchor". Any
        // other case — no validated anchor (shared missing/mismatched), or
        // global doesn't match exactly — is rejected outright.
      }
    } catch {
      // Broken symlink / permission error on this one entry — skip it, keep
      // going; never let one bad entry drop the rest of the census.
    }
  }
  return out;
}

// resolveWorktreeGitDirs — the REAL git metadata paths for a linked worktree.
// For a linked worktree (every ticket worktree under wt/<TICKET>), `git commit`
// writes per-worktree state (HEAD, index, index.lock, COMMIT_EDITMSG) under
// `--absolute-git-dir`, which lives OUTSIDE the worktree tree entirely (in the
// main checkout's `.git/worktrees/<name>/`) — and updates the object database +
// refs under `--git-common-dir` (the shared `.git`, also outside the worktree).
// Neither was previously in the sandbox's writable_roots, so `git commit` inside
// a codex-exec worktree was refused with a permission error on `index.lock`.
// Mirrors resolveGitExcludePath's spawnSync-and-fall-through style. Returns
// { gitDir, commonDir }, either null on any resolution failure — best-effort,
// never throws.
function resolveWorktreeGitDirs(worktreePath) {
  const run = (args) => {
    try {
      const res = spawnSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
      if (res && res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
        return res.stdout.trim();
      }
    } catch {
      /* best-effort */
    }
    return null;
  };
  return {
    gitDir: run(["rev-parse", "--absolute-git-dir"]),
    commonDir: run(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  };
}

// resolveWritableRoots — the de-duplicated, absolute writable-root set for the
// `-c sandbox_workspace_write.writable_roots=[…]` override: the configured roots
// ∪ {orchDir} ∪ {every resolved thoughts real-root of the worktree}
// ∪ {the worktree's real git-dir and git-common-dir, for linked worktrees}.
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
  for (const r of resolveThoughtsRoots(worktreePath)) add(r);
  const { gitDir, commonDir } = resolveWorktreeGitDirs(worktreePath);
  add(gitDir);
  add(commonDir);
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
// CATALYST_* from the spec env are preserved (only the vendor-auth / provider vars
// are stripped).
//
// CTL-1457 (N3): OpenAI provider-env scrub. On the auth.json / ChatGPT-subscription
// path (NO CODEX_API_KEY in the child env) a stray OPENAI_API_KEY or provider-base
// override inherited from the daemon env would make the codex child silently run
// METERED / against the wrong endpoint with NONE of the LOUD CODEX_API_KEY warning
// assertCodexAuth emits. So when the child is NOT in explicit API-key mode, DELETE
// the OpenAI API key + provider-override vars. When CODEX_API_KEY IS set the operator
// opted into metered API-key mode → leave the provider env intact.
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
  // CTL-1457 (N3): unless the operator explicitly opted into metered API-key mode
  // (CODEX_API_KEY present in the child env), strip the OpenAI API key + provider
  // overrides so an auth.json/ChatGPT-plan child can never silently meter or hit a
  // wrong endpoint on a leaked var. Left intact when CODEX_API_KEY is set (the
  // operator's deliberate API-key path).
  if (!env.CODEX_API_KEY) {
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_API_BASE;
    delete env.OPENAI_ORG;
    delete env.OPENAI_ORGANIZATION;
  }
  return env;
}

// resolveGitExcludePath — the worktree's git info/exclude absolute path (via
// `git rev-parse --git-path info/exclude`, falling back to manual `.git`
// resolution — see resolveGitInfoExcludeFallback — for a `git`-less
// environment). Handles the worktree `.git` being a FILE pointing at the real
// gitdir (a linked worktree). null when neither resolves. Best-effort.
function resolveGitExcludePath(worktreePath) {
  try {
    const res = spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
    });
    if (res && res.status === 0 && typeof res.stdout === "string" && res.stdout.trim()) {
      const rel = res.stdout.trim();
      return isAbsolute(rel) ? rel : join(worktreePath, rel);
    }
  } catch {
    /* fall through to the manual resolver */
  }
  return resolveGitInfoExcludeFallback(worktreePath);
}

// appendGitExcludeLine — append `pattern` as its own line to `excludePath`,
// idempotently: a no-op when any of `equivalents` (defaults to just `pattern`
// itself) is already present as a trimmed line. Best-effort — never throws.
function appendGitExcludeLine(excludePath, pattern, equivalents = [pattern]) {
  if (!excludePath) return;
  try {
    let existing = "";
    try {
      existing = readFileSync(excludePath, "utf8");
    } catch {
      /* no exclude file yet */
    }
    const lines = existing.split("\n").map((l) => l.trim());
    if (equivalents.some((eq) => lines.includes(eq))) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
  } catch {
    /* best-effort */
  }
}

// gitExcludeAgents — append the BLANKET `.agents/` pattern to the worktree's git
// info/exclude so the codex skills symlink never shows as an untracked file (D7).
// Reserved for the case where WE created `.agents/skills` WHOLESALE (a fresh
// top-level symlink, or the pre-existing-our-symlink idempotent no-op) — NEVER
// for a project-owned real `.agents/skills` dir (CTL-1530 threads dLZ + dLh +
// dLX): a real dir is never touched and never git-excluded at all now — see
// registerDevPluginSkillsIntoCodexHome — so this function's blanket pattern would
// otherwise silently untrack real, tracked project content sharing that
// directory. Recognizes the historical equivalents already written by past runs
// (`.agents`, `/.agents/`, `/.agents`) as already-present. Idempotent +
// best-effort — never throws.
function gitExcludeAgents(worktreePath) {
  appendGitExcludeLine(resolveGitExcludePath(worktreePath), ".agents/", [
    ".agents/",
    ".agents",
    "/.agents/",
    "/.agents",
  ]);
}

// ── Machine-local link-ownership registry (CTL-1530 thread pJD) ────────────────
// A prior fix (thread dLa) tried to decide "is this stale-looking symlink OURS to
// refresh?" from the TARGET'S SHAPE: absolute, outside the worktree/codexHome,
// ending in `plugins/dev/skills[/<name>]`, and resolving under the current user's
// home directory. Thread pJD found that heuristic is still wrong in principle, not
// just in degree: a project can author a link that is home-rooted AND
// suffix-matching on purpose — e.g. `.agents/skills -> ~/src/catalyst/plugins/dev/skills`
// is a perfectly reasonable vendored-checkout convention — and the shape heuristic
// cannot tell that apart from a link this runner actually created. No path shape
// can distinguish intent, so ownership is no longer INFERRED from what a target
// looks like; it is PROVEN. `<codexHome>/codex-exec-links.json` is a machine-local
// registry recording the exact coordinate + target of every symlink this runner
// has EVER created or refreshed, written through on every successful symlinkSync.
// A link is RUNNER-OWNED-STALE only when the registry has an entry for that EXACT
// coordinate whose recorded target equals the target CURRENTLY on disk (proof we
// wrote what's actually there right now) — never from path shape alone. This
// REPLACES the former `isRunnerOwnedSkillTarget` suffix/homedir heuristic entirely
// (deleted); nothing else in this module infers ownership from a target's shape.
//
// Registry shape (machine-local JSON, best-effort — a registry read/write failure
// never fails a dispatch):
//   {
//     "worktree": { "<realpath(worktreePath)>": { ".agents/skills": "<target we wrote>" } },
//     "codexHome": { "<skill-entry-name>": "<target we wrote>" }
//   }
// Read/parse failures (absent, unreadable, corrupt JSON, non-object) are
// FAIL-SAFE: treated as "we have no proof of ownership of anything", so every
// existing on-disk link is left classified foreign — this runner only ever
// refreshes/unlinks a link it can PROVE it wrote, never one merely shaped like
// something it would write. A dispatch with no codexHome configured (registry
// unavailable entirely) degrades the same way: nothing can be proven, so a
// stale-looking link is always left foreign rather than repointed — a strictly
// safer behavior than the old heuristic, never a regression in the unsafe
// direction.
const LINK_REGISTRY_FILENAME = "codex-exec-links.json";

function resolveLinkRegistryPath(codexHome) {
  return codexHome ? join(codexHome, LINK_REGISTRY_FILENAME) : null;
}

// readLinkRegistry — best-effort parse. null on ANY failure (absent, unreadable,
// corrupt JSON, or a parsed non-object) — callers MUST treat null as "no proof of
// ownership of anything", never as "empty but trustworthy".
function readLinkRegistry(codexHome) {
  const path = resolveLinkRegistryPath(codexHome);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// writeLinkRegistry — best-effort ATOMIC full-object overwrite (never merges;
// callers pass the complete desired registry): write to a temp file in the SAME
// directory, then renameSync it over the registry path (rename(2) atomically
// replaces the destination on POSIX). This guarantees a concurrent reader NEVER
// observes a partially-written file — readLinkRegistry always sees either the
// OLD complete registry or the NEW complete one, never a truncated write
// misread as corrupt (thread zc_). Never throws: a write failure only means a
// FUTURE run can't prove ownership of what we're writing now, which degrades
// safely (that future link is treated as foreign, never as "provably ours to
// clobber"). A corrupt existing file is silently REPLACED by design — a write
// here is establishing NEW proof, not verifying old proof, so discarding
// unparseable history is safe.
//
// Concurrency note (thread zc_, deliberate — NOT a bug to fix later): this
// module does NOT take a cross-process lock around the registry's
// read-modify-write. The normal daemon and a detached delegate runner can both
// dispatch through codex-exec against the SAME codexHome concurrently, each
// read the same prior registry object, and then each independently overwrite
// the whole file — the LATER write wins and the EARLIER write's new entries
// are silently dropped (a lost update). This residual race is intentionally
// left unlocked because it is fail-safe by construction: a lost entry means
// the registry no longer holds PROOF for that link, so
// isRegisteredWorktreeSkillsOwner / isRegisteredCodexHomeSkillOwner return
// false for it, and the affected link is left FOREIGN — preserved and warned,
// never wrongly repointed. The unsafe direction (proving ownership of
// something a process did NOT actually write) is impossible from a lost
// update; only the safe direction (temporarily losing proof of something a
// process DID write, until its next successful registration) is reachable.
// Cross-process locking would only close a gap whose failure mode is already
// conservative — not worth the added complexity.
function writeLinkRegistry(codexHome, registry) {
  const path = resolveLinkRegistryPath(codexHome);
  if (!path) return;
  const tmp = `${path}.codex-tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; also covers "never got far enough to create tmp" */
    }
  }
}

// atomicSymlink — replace `dest` with a fresh symlink to `target`, ATOMICALLY:
// create the new link at a temp name in the SAME directory, then renameSync it
// over `dest` (rename(2) atomically replaces an existing entry on POSIX). `dest`
// is therefore always either the OLD link or the NEW link — an unlink-then-link
// sequence has a window where `dest` is ABSENT, so any failure between the two
// steps discards a still-usable old link (thread zdB); this has no such window.
// On any failure, the temp file is cleaned up (best-effort) and the error is
// RE-THROWN so the caller's existing catch/log path still fires — `dest` itself
// is left completely untouched (still the OLD link) in every failure case.
function atomicSymlink(target, dest) {
  const tmp = `${dest}.codex-tmp-${process.pid}`;
  try {
    unlinkSync(tmp); // best-effort: clear a stale temp left by a crashed prior attempt
  } catch {
    /* absent — the common case */
  }
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

// registryWorktreeKey — the worktree coordinate used to key the "worktree" bucket:
// its realpath (falls back to the raw path on a realpath failure — best-effort,
// consistent with the rest of this module).
function registryWorktreeKey(worktreePath) {
  try {
    return realpathSync(worktreePath);
  } catch {
    return worktreePath;
  }
}

// recordWorktreeSkillsLink — write-through proof that WE just created or
// refreshed `<worktreePath>/.agents/skills -> target`. Best-effort; never throws.
function recordWorktreeSkillsLink(codexHome, worktreePath, target) {
  if (!codexHome) return;
  const registry = readLinkRegistry(codexHome) ?? {};
  const bucket = registry.worktree && typeof registry.worktree === "object" ? registry.worktree : {};
  const key = registryWorktreeKey(worktreePath);
  const entry = bucket[key] && typeof bucket[key] === "object" ? bucket[key] : {};
  bucket[key] = { ...entry, ".agents/skills": target };
  registry.worktree = bucket;
  writeLinkRegistry(codexHome, registry);
}

// isRegisteredWorktreeSkillsOwner — PROOF check for the top-level worktree link:
// true only when the registry parses AND has an entry for this exact worktree
// coordinate AND that entry's recorded target equals `currentTarget` (the target
// actually on disk right now).
function isRegisteredWorktreeSkillsOwner(codexHome, worktreePath, currentTarget) {
  if (!codexHome || !currentTarget) return false;
  const registry = readLinkRegistry(codexHome);
  if (!registry) return false; // absent/corrupt/unreadable — no proof, fail-safe
  const bucket = registry.worktree;
  if (!bucket || typeof bucket !== "object") return false;
  const entry = bucket[registryWorktreeKey(worktreePath)];
  return !!entry && typeof entry === "object" && entry[".agents/skills"] === currentTarget;
}

// recordCodexHomeSkillLink / isRegisteredCodexHomeSkillOwner — the SAME proof
// contract for a per-entry link registered under CODEX_HOME/skills/<name> (see
// registerDevPluginSkillsIntoCodexHome). Flat-keyed by entry name — the registry
// file itself already lives inside the ONE codexHome it describes, so no further
// path-scoping is needed.
function recordCodexHomeSkillLink(codexHome, name, target) {
  if (!codexHome) return;
  const registry = readLinkRegistry(codexHome) ?? {};
  const bucket = registry.codexHome && typeof registry.codexHome === "object" ? registry.codexHome : {};
  bucket[name] = target;
  registry.codexHome = bucket;
  writeLinkRegistry(codexHome, registry);
}

function isRegisteredCodexHomeSkillOwner(codexHome, name, currentTarget) {
  if (!codexHome || !currentTarget) return false;
  const registry = readLinkRegistry(codexHome);
  if (!registry) return false;
  const bucket = registry.codexHome;
  if (!bucket || typeof bucket !== "object") return false;
  return bucket[name] === currentTarget;
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

// registerDevPluginSkillsIntoCodexHome — CTL-1530 (threads dLZ + dLh + dLX): when
// `.agents/skills` is a REAL, project-owned directory (e.g. a dual-harness-migrated
// project), the runner used to MERGE per-entry symlinks straight into that real
// tree. Three findings against that design compound into "structurally broken",
// not just buggy, so this REPLACES it entirely rather than patching it further:
//
//   - dLZ: `.git/info/exclude` is the repo's COMMON exclude file — it is shared by
//     EVERY linked worktree of the same repo (`git rev-parse --git-path
//     info/exclude` resolves there even from a ticket worktree). A pattern written
//     for one ticket's dispatch persisted across every other worktree and outlived
//     that ticket's teardown, so a later dispatch injecting a skill NAME could mask
//     a REAL project skill of that same name in a completely different worktree
//     with no `git status` entry to surface it.
//   - dLh: narrowing the merge to `/^phase-/` (the prior fix for a different
//     problem) broke codex's ability to run its OWN generated prompts: buildCodexPrompt
//     only ever invokes `/catalyst-dev:phase-*` wrappers, but those wrappers
//     THEMSELVES delegate to non-phase Catalyst skills — phase-plan -> create-plan,
//     phase-research -> research-codebase, phase-implement -> implement-plan,
//     phase-pr -> create-pr, phase-review -> review-comments, etc. Codex discovers
//     slash commands through `.agents/skills`, so filtering to phase-* only
//     silently broke every migrated pipeline phase that delegates.
//   - dLX: the merged phase-* links (plus the exclude pattern they required) look,
//     to `migrate-dual-harness.sh`'s trackability audit, like ambiguous project
//     content — adding them to `DEST_PATHS` made the classifier return rc 4 on
//     every subsequent run.
//
// The common root cause is touching a project-owned real `.agents/skills` AT ALL:
// this runner is not the owner of that directory (or the repo's shared exclude
// file) and has no business writing into either. So when the directory is real, we
// now do NOT touch it and do NOT write any git exclude — instead we register the
// FULL dev-plugin skills set (not just phase-*, closing dLh) as per-entry symlinks
// under `<codexHome>/skills/`, the machine-local, out-of-repo directory this runner
// already resolves for auth (codexConfig's `codexHome`). CODEX_HOME is entirely our
// own territory (nothing else lives there), so unlike a worktree's `.agents/skills`
// there is no risk of shadowing project content, and nothing here is ever
// `git add`-able (closing dLX — there is simply nothing left for the migration
// audit to see).
//
// Per entry: ABSENT in `<codexHome>/skills/` -> create our symlink and record it
// in the link registry; present and OUR symlink pointing at the CURRENT source ->
// idempotent no-op — NEVER writes the registry here (CTL-1530 thread zc0: an
// existing link that happens to already point at `srcEntry` is not proof we
// created it — a project-authored link could coincidentally match; only a
// symlinkSync THIS runner just performed earns a registry entry, so a plain
// path-match with no prior proof stays UNREGISTERED and therefore un-repointable
// later); present and a symlink that the registry PROVES is ours but is STALE
// (an earlier dispatch's link against an old checkout root — see
// isRegisteredCodexHomeSkillOwner) -> atomically refresh to the current source
// (thread zdB — see atomicSymlink) + update the registry; present and anything
// else (an unrelated entry, a foreign symlink, an unproven "looks like ours"
// link, or an unreadable link) -> leave it untouched, WARN per-entry, and skip —
// CODEX_HOME/skills is machine/runner territory, but we still never clobber a
// non-proven entry. Best-effort per entry — one bad entry (a readdir/symlink
// failure) never aborts the rest.
function registerDevPluginSkillsIntoCodexHome(codexHome, skillsSrc, { logger } = {}) {
  if (!codexHome) {
    try {
      logger?.warn?.(
        { skillsSrc },
        "codex-exec: ensureCodexSkills found a real project-owned .agents/skills dir but no codexHome is configured — skipping machine-local skills registration",
      );
    } catch {
      /* logging must never break a dispatch */
    }
    return;
  }
  const destDir = join(codexHome, "skills");
  let entries = [];
  try {
    mkdirSync(destDir, { recursive: true });
    entries = readdirSync(skillsSrc);
  } catch (err) {
    try {
      logger?.warn?.(
        { skillsSrc, destDir, err: err?.message },
        "codex-exec: ensureCodexSkills could not prepare CODEX_HOME/skills or read the dev-plugin skills source dir — skipping registration",
      );
    } catch {
      /* logging must never break a dispatch */
    }
    return;
  }
  for (const name of entries) {
    const srcEntry = join(skillsSrc, name);
    const destEntry = join(destDir, name);
    let existingEntry = null;
    try {
      existingEntry = lstatSync(destEntry);
    } catch {
      /* absent — fall through to create our per-entry symlink */
    }
    if (existingEntry) {
      if (existingEntry.isSymbolicLink()) {
        let target = null;
        try {
          target = readlinkSync(destEntry);
        } catch {
          /* unreadable link — treat as foreign, never clobber */
        }
        if (target === srcEntry) {
          // thread zc0: NOT registered here — a matching target alone is not
          // proof we wrote it (see the function doc). The link is discoverable
          // either way; only registering it would let a later refresh wrongly
          // adopt it.
          continue; // OUR-or-coincidental symlink already correct — idempotent no-op
        }
        if (isRegisteredCodexHomeSkillOwner(codexHome, name, target)) {
          // RUNNER-OWNED-STALE, PROVEN by the registry (thread pJD): the checkout
          // root moved since this link was created. Refreshing it never touches
          // project content — CODEX_HOME/skills has none. ATOMIC (thread zdB —
          // see atomicSymlink): `destEntry` is either the OLD link or the NEW
          // one, never briefly absent, so a mid-refresh failure never discards a
          // still-usable old link.
          try {
            atomicSymlink(srcEntry, destEntry);
            recordCodexHomeSkillLink(codexHome, name, srcEntry);
          } catch (err) {
            try {
              logger?.warn?.(
                { destEntry, target, wanted: srcEntry, err: err?.message },
                "codex-exec: CODEX_HOME/skills/<name> is a stale runner-owned symlink (old checkout root) but the atomic refresh to <wanted> failed — the ORIGINAL link is left in place, untouched",
              );
            } catch {
              /* logging must never break a dispatch */
            }
          }
          continue;
        }
      }
      // Present and not ours, and not a PROVEN stale-but-owned link (a foreign
      // symlink, an unrelated entry, a link that merely LOOKS like ours but has
      // no registry proof, or an unreadable link) — leave it untouched, warn
      // per-entry, skip.
      try {
        logger?.warn?.(
          { destEntry, wanted: srcEntry },
          "codex-exec: CODEX_HOME/skills/<name> already exists and is not our symlink — leaving it untouched (skipping this skill; codex may not discover it)",
        );
      } catch {
        /* logging must never break a dispatch */
      }
      continue;
    }
    try {
      symlinkSync(srcEntry, destEntry);
      recordCodexHomeSkillLink(codexHome, name, srcEntry);
    } catch (err) {
      try {
        logger?.warn?.(
          { destEntry, err: err?.message },
          "codex-exec: ensureCodexSkills failed to create a per-entry CODEX_HOME/skills symlink",
        );
      } catch {
        /* logging must never break a dispatch */
      }
    }
  }
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
//   - ABSENT                       → create our symlink (wholesale ownership),
//     recording the write in the link registry (CTL-1530 thread pJD — see
//     isRegisteredWorktreeSkillsOwner);
//   - OUR-or-coincidental symlink (→ CURRENT src) → idempotent no-op, NEVER
//     registered here (thread zc0): matching the current source is not proof
//     WE wrote it — a project-authored link could coincidentally match, and
//     "adopting" it into the registry would let a later pluginRoot change
//     repoint a link this runner never created;
//   - RUNNER-OWNED-STALE, PROVEN by the registry → atomically refresh (thread
//     zdB — see atomicSymlink) to the current source; a link that merely LOOKS
//     runner-shaped but has no registry proof is treated as FOREIGN (thread
//     pJD closed the false positive this used to allow — see the registry doc
//     comment above);
//   - FOREIGN symlink              → leave it untouched, WARN LOUDLY, and skip;
//   - real dir (project-owned)     → NEVER touched, NEVER git-excluded (CTL-1530
//     threads dLZ + dLh + dLX — see registerDevPluginSkillsIntoCodexHome for why
//     the prior per-entry MERGE approach was structurally broken, not just buggy).
//     Instead the full dev-plugin skills set is registered machine-locally under
//     `<codexHome>/skills/`, entirely outside the project worktree/repo.
export function ensureCodexSkills(
  worktreePath,
  { pluginDirs, pluginRoot, codexHome, log: logger = log } = {},
) {
  try {
    if (!worktreePath) return;
    const devRoot = pluginRoot ?? resolveDevPluginRoot(pluginDirs);
    if (!devRoot) return;
    const skillsSrc = join(devRoot, "skills");
    const agentsDir = join(worktreePath, ".agents");
    const skillsLink = join(agentsDir, "skills");
    // A symlinked `.agents` component is foreign (a project committing
    // `.agents -> elsewhere` would have every write below land in the external
    // target) — mirror the migrator's ancestor guard: warn + skip, touch nothing.
    let agentsDirStat = null;
    try {
      agentsDirStat = lstatSync(agentsDir);
    } catch {
      /* absent — mkdir below creates it */
    }
    if (agentsDirStat?.isSymbolicLink()) {
      try {
        logger?.warn?.(
          { worktreePath, agentsDir },
          "codex-exec: .agents is itself a symlink — leaving it untouched (skipping codex skills setup; codex may not discover the phase skills)",
        );
      } catch {
        /* logging must never break a dispatch */
      }
      return;
    }
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
          // OUR-or-coincidental symlink already in place, pointing at the
          // CURRENT source — idempotent no-op (still ensure the blanket
          // exclude — WE own this path wholesale either way). NOT registered
          // here (thread zc0): a matching target alone is not proof we wrote
          // it, so a project-authored link that happens to already point at
          // skillsSrc is never adopted into the registry and can never later
          // be repointed by the stale-refresh branch below.
          gitExcludeAgents(worktreePath);
          return;
        }
        if (isRegisteredWorktreeSkillsOwner(codexHome, worktreePath, target)) {
          // RUNNER-OWNED-STALE, PROVEN by the registry (CTL-1530 thread pJD):
          // pluginDirs / codex.pluginRoot was reconfigured to a different
          // checkout since this link was created, but the registry records
          // that WE wrote the exact target currently on disk — so refreshing
          // it does not violate the T7 never-delete contract (T7 protects
          // PROJECT content; this is provably our own past creation, not
          // inferred from what the path merely looks like). ATOMIC (thread
          // zdB — see atomicSymlink): `skillsLink` is either the OLD link or
          // the NEW one, never briefly absent, so a mid-refresh failure never
          // discards a still-usable old link.
          try {
            atomicSymlink(skillsSrc, skillsLink);
            recordWorktreeSkillsLink(codexHome, worktreePath, skillsSrc);
            gitExcludeAgents(worktreePath);
          } catch (err) {
            try {
              logger?.warn?.(
                { worktreePath, skillsLink, target, wanted: skillsSrc, err: err?.message },
                "codex-exec: .agents/skills is a stale runner-owned symlink (old checkout root) but the atomic refresh to <wanted> failed — the ORIGINAL link is left in place, untouched",
              );
            } catch {
              /* logging must never break a dispatch */
            }
          }
          return;
        }
        // A symlink pointing at something ELSE with no registry proof it's
        // ours (a foreign link, or one that merely LOOKS runner-shaped —
        // thread pJD) — this runner does NOT own it. Leave it exactly as-is
        // and skip (best-effort, non-fatal).
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
      if (existing.isDirectory()) {
        // A REAL, project-owned skills directory (e.g. a dual-harness-migrated
        // project). NEVER touched, NEVER git-excluded (T7 + CTL-1530 threads
        // dLZ + dLh + dLX — see registerDevPluginSkillsIntoCodexHome's doc for
        // why the prior in-tree per-entry merge was structurally broken).
        // Instead register the full dev-plugin skills set machine-locally
        // under CODEX_HOME/skills so codex can still discover them.
        registerDevPluginSkillsIntoCodexHome(codexHome, skillsSrc, { logger });
        return;
      }
      // Anything else (e.g. a plain file at .agents/skills) — not ours, leave it.
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
    recordWorktreeSkillsLink(codexHome, worktreePath, skillsSrc);
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

    // CTL-1457 (N2): record the REAL codex child pid on the registry projection. The
    // projection's `pid` is the DAEMON's; this child is a genuine subprocess that can
    // outlive a daemon crash, so boot reconcile needs its own pid to kill the orphan.
    // Optional-chained: a test-injected registry handle may omit the setter, and a
    // fake EventEmitter child has no numeric pid (setChildPid coerces that to null).
    reg.setChildPid?.(child?.pid);

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
  // CTL-1530: also pass cfg.codexHome — the real-project-dir path registers the
  // dev-plugin skills there instead of touching the worktree's .agents/skills.
  prepareWorktree(wt, { pluginDirs: spec.pluginDirs, pluginRoot: cfg.pluginRoot, codexHome: cfg.codexHome });

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

      // clean exit (exitCode === 0) — the shared clean-exit handler. A no-op when
      // the skill's own phase-agent-emit-complete already wrote a terminal (the
      // normal path) or the generation is stale. CTL-1790: when the signal is STILL
      // in-flight the process exited without the agent ever declaring completion,
      // so this writes a terminal FAILURE (ended-without-declaration) — releasing
      // the slot without fabricating a success. Call site kept verbatim.
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
