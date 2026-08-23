// codex-account-client.test.mjs — the app-server client, driven against an
// INJECTED spawn seam. No real `codex`, no network, no token spend.
//
// Pinned in .github/workflows/execution-core-tests.yml in the same change that
// created it (CI runs an enumerated list; an unpinned suite is an inert suite).
// ⚠️ Run by name — a bare `bun test` in this directory is truncated by
// agent-liveness.test.mjs's process.exit(). See codex-account-plane.test.mjs.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { readAccountPlane, discoverCodexHomes } from "./codex-account-client.mjs";

// ── The measured payloads (mini-2, codex-cli 0.147.0, 2026-08-22) ───────────
const LIVE_RATE_LIMITS = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 },
    secondary: null,
    planType: "pro",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1787463418 },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1788050218 },
      planType: "pro",
      rateLimitReachedType: null,
    },
    codex: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1787802784 },
      secondary: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
  },
};

const LIVE_ACCOUNT = {
  account: { type: "chatgpt", email: "openai@rozich.com", planType: "pro" },
  requiresOpenaiAuth: true,
};

// The app-server really does interleave this unsolicited notification between
// replies — captured verbatim from the live probe. It has no `id`, so a client
// that matched replies by arrival order rather than by id would consume it as
// the answer to `account/read`.
const LIVE_NOTIFICATION = {
  method: "remoteControl/status/changed",
  params: { status: "disabled", serverName: "mini-2.rozich" },
  emittedAtMs: 1787445417594,
};

// ── A fake child process implementing just enough of the ChildProcess surface ──
function makeFakeSpawn(behaviour) {
  const record = { env: null, bin: null, args: null, killed: false, written: [] };
  const spawnFn = (bin, args, opts) => {
    record.bin = bin;
    record.args = args;
    record.env = opts?.env ?? null;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: (chunk) => {
        const msg = JSON.parse(String(chunk).trim());
        record.written.push(msg);
        queueMicrotask(() => behaviour(msg, (obj) => child.stdout.emit("data", JSON.stringify(obj) + "\n")));
        return true;
      },
      end: () => {},
      on: () => {},
    };
    child.kill = () => {
      record.killed = true;
      return true;
    };
    return child;
  };
  return { spawnFn, record };
}

/** Answers every RPC correctly, echoing back the home it was given. */
function okBehaviour(home, { rateLimits = LIVE_RATE_LIMITS, account = LIVE_ACCOUNT } = {}) {
  return (msg, reply) => {
    if (msg.method === "initialize") reply({ id: msg.id, result: { codexHome: home } });
    else if (msg.method === "account/read") reply({ id: msg.id, result: account });
    else if (msg.method === "account/rateLimits/read") reply({ id: msg.id, result: rateLimits });
  };
}

describe("readAccountPlane", () => {
  test("sends initialize before any account RPC", async () => {
    const { spawnFn, record } = makeFakeSpawn(okBehaviour("/h/a"));
    await readAccountPlane({ codexHome: "/h/a", spawnFn });
    expect(record.written[0].method).toBe("initialize");
    expect(record.written.map((m) => m.method)).toContain("account/rateLimits/read");
    expect(record.written.map((m) => m.method)).toContain("account/read");
  });

  test("passes CODEX_HOME to the child, and only that home", async () => {
    const { spawnFn, record } = makeFakeSpawn(okBehaviour("/h/acct2"));
    await readAccountPlane({ codexHome: "/h/acct2", spawnFn });
    expect(record.env.CODEX_HOME).toBe("/h/acct2");
  });

  test("spawns the app-server subcommand", async () => {
    const { spawnFn, record } = makeFakeSpawn(okBehaviour("/h/a"));
    await readAccountPlane({ codexHome: "/h/a", spawnFn, bin: "/custom/codex" });
    expect(record.bin).toBe("/custom/codex");
    expect(record.args).toEqual(["app-server"]);
  });

  test("a fully answered read is ok and carries the parsed buckets", async () => {
    const { spawnFn } = makeFakeSpawn(okBehaviour("/h/a"));
    const v = await readAccountPlane({ codexHome: "/h/a", spawnFn });
    expect(v.status).toBe("ok");
    expect(v.email).toBe("openai@rozich.com");
    // The measured correction: the `codex` bucket is WEEKLY-only.
    const codex = v.buckets.find((b) => b.limitId === "codex");
    expect(codex.windows.map((w) => w.label)).toEqual(["weekly"]);
  });

  // ⛔ A hung child must not hang `status`.
  test("a child that never answers resolves as an error inside the timeout", async () => {
    const { spawnFn } = makeFakeSpawn(() => {});
    const v = await readAccountPlane({ codexHome: "/h/a", spawnFn, timeoutMs: 50 });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/timed out/);
  });

  test("the child is always killed, including on the timeout path", async () => {
    const { spawnFn, record } = makeFakeSpawn(() => {});
    await readAccountPlane({ codexHome: "/h/a", spawnFn, timeoutMs: 50 });
    expect(record.killed).toBe(true);
  });

  test("the child is killed on the happy path too — no leaked app-server", async () => {
    const { spawnFn, record } = makeFakeSpawn(okBehaviour("/h/a"));
    await readAccountPlane({ codexHome: "/h/a", spawnFn });
    expect(record.killed).toBe(true);
  });

  test("a spawn failure (codex absent) is an error, not a crash", async () => {
    const v = await readAccountPlane({
      codexHome: "/h/a",
      spawnFn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/ENOENT/);
  });

  test("a child error event is an error, not an unhandled rejection", async () => {
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => true, end: () => {}, on: () => {} };
      child.kill = () => true;
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    };
    const v = await readAccountPlane({ codexHome: "/h/a", spawnFn, timeoutMs: 500 });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/EACCES/);
  });

  // The server interleaves unsolicited notifications; they must not be mistaken
  // for replies. Captured live — see LIVE_NOTIFICATION.
  test("unsolicited notifications are ignored", async () => {
    const { spawnFn } = makeFakeSpawn((msg, reply) => {
      reply(LIVE_NOTIFICATION);
      okBehaviour("/h/a")(msg, reply);
      reply(LIVE_NOTIFICATION);
    });
    const v = await readAccountPlane({ codexHome: "/h/a", spawnFn });
    expect(v.status).toBe("ok");
  });

  test("replies arriving out of id order are matched by id", async () => {
    // The handshake is sequential (initialize is answered before the client
    // sends anything else), so the genuinely concurrent pair is account/read +
    // account/rateLimits/read — they go out together. Buffer those two and
    // answer them in REVERSE order, which is what the id-matching exists for.
    const pending = [];
    const { spawnFn } = makeFakeSpawn((msg, reply) => {
      if (msg.method === "initialize") {
        okBehaviour("/h/a")(msg, reply);
        return;
      }
      if (msg.method === "initialized") return; // a notification, no reply
      pending.push([msg, reply]);
      if (pending.length === 2) {
        for (const [m, r] of pending.reverse()) okBehaviour("/h/a")(m, r);
      }
    });
    const v = await readAccountPlane({ codexHome: "/h/a", spawnFn, timeoutMs: 2000 });
    expect(v.status).toBe("ok");
    // Prove the reversal actually happened, so this cannot pass vacuously.
    expect(pending[0][0].method).toBe("account/rateLimits/read");
  });

  test("an unauthenticated home is unauthenticated, never ok", async () => {
    const { spawnFn } = makeFakeSpawn((msg, reply) => {
      if (msg.method === "initialize") reply({ id: msg.id, result: { codexHome: "/h/empty" } });
      else if (msg.method === "account/read")
        reply({ id: msg.id, result: { account: null, requiresOpenaiAuth: true } });
      else if (msg.method === "account/rateLimits/read")
        reply({
          id: msg.id,
          error: { code: -32600, message: "codex account authentication required to read rate limits" },
        });
    });
    const v = await readAccountPlane({ codexHome: "/h/empty", spawnFn });
    expect(v.status).toBe("unauthenticated");
    expect(v.reason).toMatch(/authentication required/);
  });

  // ⛔ THE SYMLINK TRAP, measured: the app-server realpath-resolves CODEX_HOME
  // (asking for /tmp/x echoed back /private/tmp/x). The fleet selector
  // ~/catalyst/codex-home IS a symlink, so a raw string compare would report a
  // home mismatch on every single healthy read and never return ok.
  test("a realpath-resolved echo still matches the requested (symlinked) home", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ctl2072-link-"));
    scratches.push(scratch);
    const target = join(scratch, "codex-home-acct7");
    mkdirSync(target);
    const link = join(scratch, "codex-home");
    symlinkSync(target, link);
    // The child echoes the REAL path, as the live server does.
    const { spawnFn } = makeFakeSpawn(okBehaviour(realpathSync(target)));
    const v = await readAccountPlane({ codexHome: link, spawnFn });
    expect(v.status).toBe("ok");
  });

  test("a genuinely different home is still caught as an error", async () => {
    const { spawnFn } = makeFakeSpawn(okBehaviour("/h/acct9"));
    const v = await readAccountPlane({ codexHome: "/h/acct1", spawnFn });
    expect(v.status).toBe("error");
    expect(v.reason).toMatch(/different account/);
  });

  test("never throws, whatever the child does", async () => {
    const garbage = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: () => {
          child.stdout.emit("data", "this is not json\n{{{\n");
          return true;
        },
        end: () => {},
        on: () => {},
      };
      child.kill = () => true;
      return child;
    };
    const v = await readAccountPlane({ codexHome: "/h/a", spawnFn: garbage, timeoutMs: 50 });
    expect(v.status).toBe("error");
  });
});

// ── discoverCodexHomes ──────────────────────────────────────────────────────
const scratches = [];
afterEach(() => {
  while (scratches.length) {
    try {
      rmSync(scratches.pop(), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function scratchRoot() {
  const d = mkdtempSync(join(tmpdir(), "ctl2072-homes-"));
  scratches.push(d);
  return d;
}

describe("discoverCodexHomes", () => {
  test("finds codex-home-acctN dirs and the active symlink target", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "codex-home-acct1"));
    mkdirSync(join(root, "codex-home-acct3"));
    symlinkSync(join(root, "codex-home-acct3"), join(root, "codex-home"));
    const d = discoverCodexHomes(root);
    expect(d.accounts.map((a) => a.handle)).toEqual(["acct1", "acct3"]);
    expect(d.activeHandle).toBe("acct3");
    expect(d.selectorKind).toBe("symlink");
  });

  test("accounts are sorted numerically, so acct10 follows acct9", () => {
    const root = scratchRoot();
    for (const n of [1, 2, 9, 10]) mkdirSync(join(root, `codex-home-acct${n}`));
    expect(discoverCodexHomes(root).accounts.map((a) => a.handle)).toEqual([
      "acct1",
      "acct2",
      "acct9",
      "acct10",
    ]);
  });

  test("a dangling selector symlink reports null active, never a guess", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "codex-home-acct1"));
    symlinkSync(join(root, "codex-home-acctGONE"), join(root, "codex-home"));
    const d = discoverCodexHomes(root);
    expect(d.activeHandle).toBeNull();
    expect(d.selectorKind).toBe("dangling");
  });

  test("a selector that is a real directory (not a symlink) is reported as pinned", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "codex-home-acct1"));
    mkdirSync(join(root, "codex-home"));
    expect(discoverCodexHomes(root).selectorKind).toBe("directory");
  });

  test("an absent selector is 'absent' with a null active handle", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "codex-home-acct1"));
    const d = discoverCodexHomes(root);
    expect(d.selectorKind).toBe("absent");
    expect(d.activeHandle).toBeNull();
  });

  test("a selector pointing outside the acctN naming yields a null handle, not a guess", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "codex-home-acct1"));
    mkdirSync(join(root, "somewhere-else"));
    symlinkSync(join(root, "somewhere-else"), join(root, "codex-home"));
    const d = discoverCodexHomes(root);
    expect(d.activeHandle).toBeNull();
    expect(d.selectorTarget).toContain("somewhere-else");
  });

  test("no accounts → empty list, not a throw", () => {
    expect(discoverCodexHomes(scratchRoot()).accounts).toEqual([]);
  });

  test("a nonexistent root is empty and absent, not a throw", () => {
    const d = discoverCodexHomes("/nonexistent/ctl2072/root");
    expect(d.accounts).toEqual([]);
    expect(d.selectorKind).toBe("absent");
  });

  test("each account records whether it is authed (auth.json present)", () => {
    const root = scratchRoot();
    mkdirSync(join(root, "codex-home-acct1"));
    writeFileSync(join(root, "codex-home-acct1", "auth.json"), "{}");
    mkdirSync(join(root, "codex-home-acct2"));
    const d = discoverCodexHomes(root);
    expect(d.accounts.find((a) => a.handle === "acct1").hasAuth).toBe(true);
    expect(d.accounts.find((a) => a.handle === "acct2").hasAuth).toBe(false);
  });

  test("a stray file named like a home is not reported as an account", () => {
    const root = scratchRoot();
    writeFileSync(join(root, "codex-home-acct4"), "not a directory");
    expect(discoverCodexHomes(root).accounts).toEqual([]);
  });
});
