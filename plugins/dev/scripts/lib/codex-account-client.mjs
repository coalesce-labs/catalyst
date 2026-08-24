// codex-account-client.mjs — drive one short-lived `codex app-server` stdio child
// per account home and hand the raw results to the pure core for judgement.
//
// ZERO TOKEN SPEND. This is the whole reason the Codex tool is structurally
// simpler than its Claude twin: `claude-accounts-usage.mjs` must spend one
// max_tokens:1 inference call per account, because a durable setup-token 403s
// the account-usage API and only /v1/messages carries the rate-limit headers.
// Codex exposes a documented account plane that answers for free.
//
// Measured live on mini-2 (codex-cli 0.147.0, 2026-08-22):
//   initialize                → {"id":1,"result":{"codexHome":"/Users/ryan/catalyst/codex-home-acct1", ...}}
//   account/read              → {"id":2,"result":{"account":{"type":"chatgpt","email":"…","planType":"pro"}, …}}
//   account/rateLimits/read   → {"id":3,"result":{"rateLimits":{…},"rateLimitsByLimitId":{…}}}
// and on an EMPTY home:
//   account/read              → {"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}
//   account/rateLimits/read   → {"error":{"code":-32600,"message":"codex account authentication required…"},"id":3}
//
// ── TWO PROTOCOL FACTS THAT DECIDE THE IMPLEMENTATION ───────────────────────
//
// 1. THE SERVER INTERLEAVES UNSOLICITED NOTIFICATIONS. Captured verbatim between
//    the initialize reply and the account/read reply:
//      {"method":"remoteControl/status/changed","params":{…},"emittedAtMs":…}
//    It carries NO `id`. A client that paired replies with requests by arrival
//    order would consume this as the answer to account/read and then misreport
//    every account. Replies are therefore matched by JSON-RPC `id`, never by
//    position.
//
// 2. ⛔ THE SERVER REALPATH-RESOLVES CODEX_HOME. Asking for `/tmp/x` echoed back
//    `/private/tmp/x` on macOS. This matters enormously here because the fleet
//    selector `~/catalyst/codex-home` IS A SYMLINK — it is the whole switching
//    mechanism. Comparing the echo to the requested path as raw strings would
//    report a home mismatch on EVERY healthy read of the selector and never
//    return `ok`. Both sides are resolved through realpath before comparison,
//    which keeps the positive control meaningful (a genuinely different account
//    still mismatches) without breaking on the symlink it is meant to traverse.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyAccountPlane, handleFromHomePath, parseNdjson } from "./codex-account-plane.mjs";

const DEFAULT_TIMEOUT_MS = 15000;
const SELECTOR_NAME = "codex-home";
const HOME_PREFIX = "codex-home-";

/**
 * realpath, or the input unchanged when it cannot be resolved.
 *
 * Returning the raw path on failure is deliberate: an unresolvable path must not
 * become `null`, because `null === null` would make two DIFFERENT unresolvable
 * homes compare equal and defeat the positive control.
 */
function realPathOrSelf(p) {
  if (typeof p !== "string" || !p) return p;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Read one account home's plane. Never throws and never leaves a child running.
 *
 * Returns the pure core's verdict (see codex-account-plane.mjs) augmented with
 * the home and handle it describes.
 */
export async function readAccountPlane({
  codexHome,
  bin = "codex",
  spawnFn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const requestedHome = realPathOrSelf(codexHome);
  const raw = await driveAppServer({ codexHome, bin, spawnFn, timeoutMs });

  // Resolve the echo the same way, so the symlinked selector still matches.
  const initialize = raw.initialize ? { ...raw.initialize } : raw.initialize;
  if (initialize && typeof initialize.codexHome === "string") {
    initialize.codexHome = realPathOrSelf(initialize.codexHome);
  }

  const verdict = classifyAccountPlane({
    requestedHome,
    initialize,
    account: raw.account,
    rateLimits: raw.rateLimits,
    rateLimitsError: raw.rateLimitsError,
    error: raw.error,
  });

  return {
    ...verdict,
    codexHome,
    resolvedHome: requestedHome,
    handle: handleFromHomePath(requestedHome) ?? handleFromHomePath(codexHome),
  };
}

/**
 * The transport half: one child, three RPCs, replies matched by id.
 * Resolves `{ initialize, account, rateLimits, rateLimitsError, error }` — never rejects.
 */
function driveAppServer({ codexHome, bin, spawnFn, timeoutMs }) {
  return new Promise((resolveOuter) => {
    const out = {
      initialize: null,
      account: null,
      rateLimits: null,
      rateLimitsError: null,
      error: null,
    };

    let child;
    let settled = false;
    let timer = null;

    // ⚠️ ALWAYS kills the child. A leaked app-server per `status` invocation is
    // exactly the "cleanup was load-bearing and broke" failure AGENTS.md warns
    // about, and this runs on an operator's interactive command.
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) out.error = err;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolveOuter(out);
    };

    try {
      child = spawnFn(bin, ["app-server"], {
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      finish(e?.message ?? String(e));
      return;
    }

    // ⛔ A FAILED STDIN WRITE IS AN UNCAUGHT 'error' EVENT, NOT A CATCHABLE THROW.
    // `send()` wraps write() in try/catch, but a stream reports EPIPE
    // ASYNCHRONOUSLY by emitting 'error' — and an 'error' event with no listener
    // is rethrown by Node as an uncaughtException that kills the whole process.
    // Reproduced deterministically (5/5) against an app-server that answers
    // `initialize` and then exits — a protocol/version rejection, a crash, or a
    // failed auth handshake all take that shape, and the follow-up writes this
    // handler issues from the stdout callback then land on a closed pipe. It
    // crashed `catalyst-stack codex-account status`, aborted
    // codex-accounts-usage.mjs's per-account sweep BEFORE the remaining accounts
    // were read, and — because the process died outside finish() — ORPHANED the
    // app-server child that finish()'s SIGKILL exists to reap. That contradicts
    // both of this module's stated contracts ("Never throws and never leaves a
    // child running"). Routing it into finish() turns it back into the ordinary
    // error verdict the `close` handler already produces, and immediately: a lost
    // request can never be answered, so waiting out the 15s timeout buys nothing.
    child.stdin?.on?.("error", () =>
      finish("could not write to the codex app-server's stdin (it closed the pipe)"),
    );
    // Drain stderr. `stdio` asks for a pipe, so an app-server that writes more
    // than the ~64 KiB pipe buffer would BLOCK on that write and answer nothing
    // until the timeout — turning a merely noisy host into a uniform 15s-per-
    // account error read that looks like a codex outage. Attaching a 'data'
    // listener puts the stream in flowing mode; the bytes are deliberately
    // discarded, never logged, since this pipe may carry auth diagnostics.
    child.stderr?.on?.("data", () => {});

    timer = setTimeout(
      () => finish(`timed out after ${timeoutMs}ms waiting for the codex app-server`),
      timeoutMs,
    );

    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch (e) {
        finish(e?.message ?? String(e));
      }
    };

    // Requests keyed by id — NEVER by arrival order, because the server
    // interleaves id-less notifications (see the header).
    const ID_INITIALIZE = 1;
    const ID_ACCOUNT = 2;
    const ID_RATE_LIMITS = 3;
    const seen = new Set();

    const framer = parseNdjson();
    child.stdout.on("data", (chunk) => {
      let frames;
      try {
        frames = framer.push(chunk);
      } catch {
        return; // the framer already swallows bad lines; belt and braces
      }
      for (const frame of frames) {
        if (frame.id === undefined || frame.id === null) continue; // notification
        seen.add(frame.id);
        if (frame.id === ID_INITIALIZE) {
          out.initialize = frame.result ?? {};
          // Complete the handshake, then ask both questions.
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: ID_ACCOUNT, method: "account/read", params: {} });
          send({ jsonrpc: "2.0", id: ID_RATE_LIMITS, method: "account/rateLimits/read", params: {} });
        } else if (frame.id === ID_ACCOUNT) {
          if (frame.error) out.account = { account: null, error: frame.error };
          else out.account = frame.result ?? null;
        } else if (frame.id === ID_RATE_LIMITS) {
          if (frame.error) out.rateLimitsError = frame.error;
          else out.rateLimits = frame.result ?? null;
        }
      }
      if (seen.has(ID_ACCOUNT) && seen.has(ID_RATE_LIMITS)) finish(null);
    });

    child.stdout.on("error", () => finish("app-server stdout error"));
    child.on("error", (e) => finish(e?.message ?? String(e)));
    child.on("close", () => {
      // A child that exits before answering is an error, not a silent empty read.
      if (!settled && !(seen.has(ID_ACCOUNT) && seen.has(ID_RATE_LIMITS))) {
        finish("the codex app-server exited before answering");
      }
    });

    send({
      jsonrpc: "2.0",
      id: ID_INITIALIZE,
      method: "initialize",
      params: {
        clientInfo: { name: "catalyst-codex-account", title: "Catalyst", version: "1.0.0" },
      },
    });
  });
}

/**
 * Enumerate the per-account homes and resolve the fleet selector.
 *
 * The layout already exists on the fleet, undocumented and unmanaged
 * (measured 2026-08-22): `codex-home-acct1`, `codex-home-acct2`, and a bare
 * `codex-home` SYMLINK hand-created 2026-08-07 that is the de-facto selector.
 * This adopts it in place rather than replacing it.
 *
 * `selectorKind` is four-valued so an operator can tell the cases apart:
 *   symlink   — the managed case; `activeHandle` names the target
 *   directory — a real directory sits where the selector should be: PINNED, and
 *               not ours to delete (a switch must refuse, not `rm -rf` it)
 *   dangling  — a symlink to nothing; `activeHandle` is null, never a guess
 *   absent    — no selector at all
 */
export function discoverCodexHomes(root) {
  const base = root ? resolve(root) : resolve(process.env.HOME ?? "", "catalyst");
  const result = {
    root: base,
    accounts: [],
    activeHandle: null,
    selectorKind: "absent",
    selectorPath: join(base, SELECTOR_NAME),
    selectorTarget: null,
  };

  let entries = [];
  try {
    entries = readdirSync(base);
  } catch {
    return result; // a nonexistent root is empty, not an exception
  }

  for (const name of entries) {
    if (!name.startsWith(HOME_PREFIX)) continue;
    const path = join(base, name);
    const handle = handleFromHomePath(path);
    if (!handle) continue; // codex-home-scratch et al are not accounts
    try {
      if (!statSync(path).isDirectory()) continue; // a stray FILE is not an account
    } catch {
      continue;
    }
    result.accounts.push({ handle, path, hasAuth: existsSync(join(path, "auth.json")) });
  }

  // Numeric order, so acct10 follows acct9 rather than acct1.
  result.accounts.sort((a, b) => {
    const n = (h) => Number.parseInt(h.replace(/^acct/, ""), 10);
    return n(a.handle) - n(b.handle);
  });

  const selector = result.selectorPath;
  let link;
  try {
    link = lstatSync(selector);
  } catch {
    return result; // absent
  }

  if (link.isSymbolicLink()) {
    let target = null;
    try {
      target = realpathSync(selector);
    } catch {
      result.selectorKind = "dangling";
      return result;
    }
    result.selectorKind = "symlink";
    result.selectorTarget = target;
    result.activeHandle = handleFromHomePath(target); // null when it points somewhere unnamed
  } else if (link.isDirectory()) {
    result.selectorKind = "directory";
    result.selectorTarget = selector;
  }

  return result;
}
