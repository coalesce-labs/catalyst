// accounts.test.mjs — CTL-812 Domain 1. enumerateAccounts(): active-first
// ordering, empty-backup-dir fallback to active-only, backup token refresh,
// refresh-failure-drops-the-account (silent-but-logged WITHOUT the token), and
// the real defaultListBackups against fake on-disk dir contents. All seams
// injected; no real keychain, network, or (except the listBackups suite) FS.
//
// SECRETS HYGIENE: every fixture token is obviously fake.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test accounts.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enumerateAccounts,
  defaultListBackups,
  defaultRefreshToken,
} from "./accounts.mjs";

const ACTIVE_TOKEN = "FAKE-active-access-token-never-logged";

// ─── active account ──────────────────────────────────────────────────────────

describe("enumerateAccounts — active account", () => {
  test("returns the active account first with source:'active' and no file", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => ACTIVE_TOKEN,
      listBackups: () => [],
    });
    expect(accounts).toEqual([{ source: "active", token: ACTIVE_TOKEN }]);
  });

  test("no active token + no backups → empty list (no throw)", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => null,
      listBackups: () => [],
    });
    expect(accounts).toEqual([]);
  });

  test("a throwing readActiveToken is swallowed; falls through to backups", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => {
        throw new Error("keychain locked");
      },
      listBackups: () => [{ file: "a.json", token: "stale-a", refreshToken: "rt-a" }],
      refreshToken: async () => "FAKE-fresh-a",
    });
    expect(accounts).toEqual([{ source: "backup", token: "FAKE-fresh-a", file: "a.json" }]);
  });
});

// ─── empty-dir fallback ──────────────────────────────────────────────────────

describe("enumerateAccounts — empty-dir fallback", () => {
  test("empty backup dir → active-only (the common single-account host)", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => ACTIVE_TOKEN,
      listBackups: () => [], // dir absent / empty
      refreshToken: async () => {
        throw new Error("refresh should never be called when there are no backups");
      },
    });
    expect(accounts).toEqual([{ source: "active", token: ACTIVE_TOKEN }]);
  });

  test("a throwing listBackups is swallowed → active-only", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => ACTIVE_TOKEN,
      listBackups: () => {
        throw new Error("EACCES");
      },
    });
    expect(accounts).toEqual([{ source: "active", token: ACTIVE_TOKEN }]);
  });
});

// ─── backups: refresh + ordering ─────────────────────────────────────────────

describe("enumerateAccounts — backups", () => {
  test("each backup is refreshed and appended after the active account, in order", async () => {
    const seenRefresh = [];
    const accounts = await enumerateAccounts({
      readActiveToken: () => ACTIVE_TOKEN,
      listBackups: () => [
        { file: "alice.json", token: "stale-alice", refreshToken: "rt-alice" },
        { file: "bob.json", token: "stale-bob", refreshToken: "rt-bob" },
      ],
      refreshToken: async (rt) => {
        seenRefresh.push(rt);
        return `FAKE-fresh-${rt}`;
      },
    });
    expect(accounts).toEqual([
      { source: "active", token: ACTIVE_TOKEN },
      { source: "backup", token: "FAKE-fresh-rt-alice", file: "alice.json" },
      { source: "backup", token: "FAKE-fresh-rt-bob", file: "bob.json" },
    ]);
    // The refresh seam is invoked with each backup's refresh token.
    expect(seenRefresh).toEqual(["rt-alice", "rt-bob"]);
  });

  test("backups can be returned with no active account (backup-only host)", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => null,
      listBackups: () => [{ file: "alice.json", token: "stale", refreshToken: "rt" }],
      refreshToken: async () => "FAKE-fresh",
    });
    expect(accounts).toEqual([{ source: "backup", token: "FAKE-fresh", file: "alice.json" }]);
  });
});

// ─── refresh failure drops the account (silent-but-logged, no token) ──────────

describe("enumerateAccounts — refresh failure", () => {
  test("a backup whose refresh returns null is dropped; siblings survive", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => ACTIVE_TOKEN,
      listBackups: () => [
        { file: "good.json", token: "stale-good", refreshToken: "rt-good" },
        { file: "expired.json", token: "stale-bad", refreshToken: "rt-bad" },
      ],
      refreshToken: async (rt) => (rt === "rt-bad" ? null : "FAKE-fresh-good"),
    });
    expect(accounts).toEqual([
      { source: "active", token: ACTIVE_TOKEN },
      { source: "backup", token: "FAKE-fresh-good", file: "good.json" },
    ]);
    // The expired backup is absent — dropped, not crashed.
    expect(accounts.some((a) => a.file === "expired.json")).toBe(false);
  });

  test("a throwing refreshToken drops only that account (no throw)", async () => {
    const accounts = await enumerateAccounts({
      readActiveToken: () => null,
      listBackups: () => [
        { file: "boom.json", token: "stale", refreshToken: "rt-boom" },
        { file: "ok.json", token: "stale", refreshToken: "rt-ok" },
      ],
      refreshToken: async (rt) => {
        if (rt === "rt-boom") throw new Error("network down");
        return "FAKE-fresh-ok";
      },
    });
    expect(accounts).toEqual([{ source: "backup", token: "FAKE-fresh-ok", file: "ok.json" }]);
  });

  test("the refresh-failure warning never carries a token (secrets hygiene)", async () => {
    // Capture stderr/stdout: the console-shim logger writes there. The fake
    // tokens must never appear in any line the agent emits on a refresh failure.
    const SECRET_RT = "FAKE-SECRET-refresh-token-MUST-NOT-LEAK";
    const writes = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk, ...rest) => {
      writes.push(String(chunk));
      return origOut(chunk, ...rest);
    };
    process.stderr.write = (chunk, ...rest) => {
      writes.push(String(chunk));
      return origErr(chunk, ...rest);
    };
    try {
      await enumerateAccounts({
        readActiveToken: () => null,
        listBackups: () => [{ file: "leak.json", token: "FAKE-SECRET-access", refreshToken: SECRET_RT }],
        refreshToken: async () => null, // force the failure path
      });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    const all = writes.join("");
    expect(all).not.toContain(SECRET_RT);
    expect(all).not.toContain("FAKE-SECRET-access");
    // But the file name IS allowed in the warning (low-cardinality, no secret).
    expect(all).toContain("leak.json");
  });
});

// ─── defaultListBackups against real fake-dir contents ───────────────────────

describe("defaultListBackups — fake on-disk dir contents", () => {
  test("parses each .json credential file into {file, token, refreshToken}", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl812-swap-"));
    writeFileSync(
      join(dir, "alice.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-a-access", refreshToken: "FAKE-a-rt" } }),
    );
    writeFileSync(
      join(dir, "bob.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-b-access", refreshToken: "FAKE-b-rt" } }),
    );
    const backups = defaultListBackups(dir).sort((a, b) => a.file.localeCompare(b.file));
    expect(backups).toEqual([
      { file: "alice.json", token: "FAKE-a-access", refreshToken: "FAKE-a-rt" },
      { file: "bob.json", token: "FAKE-b-access", refreshToken: "FAKE-b-rt" },
    ]);
  });

  test("a missing directory yields [] (single-account host)", () => {
    const missing = join(tmpdir(), "ctl812-does-not-exist-" + Math.random().toString(36).slice(2));
    expect(defaultListBackups(missing)).toEqual([]);
  });

  test("non-.json files and garbled JSON are skipped silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl812-swap-mixed-"));
    writeFileSync(join(dir, "good.json"), JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ok", refreshToken: "FAKE-rt" } }));
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    writeFileSync(join(dir, "garbled.json"), "{not valid json");
    const backups = defaultListBackups(dir);
    expect(backups).toEqual([{ file: "good.json", token: "FAKE-ok", refreshToken: "FAKE-rt" }]);
  });

  test("a credential file without claudeAiOauth yields null token/refreshToken (still listed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl812-swap-empty-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ somethingElse: true }));
    expect(defaultListBackups(dir)).toEqual([{ file: "empty.json", token: null, refreshToken: null }]);
  });
});

// ─── defaultRefreshToken with injected fetch ─────────────────────────────────

describe("defaultRefreshToken — injected fetch", () => {
  test("a 200 with access_token returns the fresh token", async () => {
    const fetchImpl = async () => ({ status: 200, json: async () => ({ access_token: "FAKE-fresh-200" }) });
    expect(await defaultRefreshToken("FAKE-rt", { fetchImpl })).toBe("FAKE-fresh-200");
  });

  test("a 200 with the nested claudeAiOauth shape is also accepted", async () => {
    const fetchImpl = async () => ({
      status: 200,
      json: async () => ({ claudeAiOauth: { accessToken: "FAKE-nested" } }),
    });
    expect(await defaultRefreshToken("FAKE-rt", { fetchImpl })).toBe("FAKE-nested");
  });

  test("a null refresh token short-circuits to null without calling fetch", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    };
    expect(await defaultRefreshToken(null, { fetchImpl })).toBe(null);
    expect(called).toBe(false);
  });

  test("a non-200 status returns null (never throws)", async () => {
    const fetchImpl = async () => ({ status: 400, json: async () => ({}) });
    expect(await defaultRefreshToken("FAKE-rt", { fetchImpl })).toBe(null);
  });

  test("a throwing fetch returns null (never throws)", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(defaultRefreshToken("FAKE-rt", { fetchImpl })).resolves.toBe(null);
  });

  test("the POST body carries grant_type/refresh_token/client_id; never logs the token", async () => {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, json: async () => ({ access_token: "FAKE-fresh" }) };
    };
    await defaultRefreshToken("FAKE-rt-secret", { fetchImpl });
    expect(captured.url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(captured.init.method).toBe("POST");
    const body = JSON.parse(captured.init.body);
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("FAKE-rt-secret");
    expect(body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
});

// ─── enumerateAccounts × the REAL defaultRefreshToken (arg-shape) ─────────────

describe("enumerateAccounts — real defaultRefreshToken integration (no injected refresh)", () => {
  // CTL-812 review: enumerateAccounts used to call refreshToken(rt, { file }) but
  // defaultRefreshToken's 2nd arg is { fetchImpl } — the { file } was silently
  // ignored. These tests drive enumerateAccounts through the REAL defaultRefreshToken
  // (NOT an injected stub), monkeypatching globalThis.fetch so no real network is
  // touched, proving the default refresh seam actually works end to end via
  // enumerateAccounts and that the (now corrected) call shape refreshes backups.
  test("a backup is refreshed through the real defaultRefreshToken (fetch monkeypatched)", async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => ({ access_token: "FAKE-fresh-from-real-refresh" }) };
    };
    try {
      const accounts = await enumerateAccounts({
        readActiveToken: () => null,
        listBackups: () => [{ file: "swap.json", token: "FAKE-stale", refreshToken: "FAKE-rt-real" }],
        // refreshToken intentionally OMITTED → exercises the real defaultRefreshToken.
      });
      expect(accounts).toEqual([
        { source: "backup", token: "FAKE-fresh-from-real-refresh", file: "swap.json" },
      ]);
      // The real refresh seam actually hit the token endpoint with the backup's rt.
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(JSON.parse(calls[0].init.body).refresh_token).toBe("FAKE-rt-real");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a real-refresh failure (non-200) drops the backup; no token leaks in the warning", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 401, json: async () => ({}) });
    const writes = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = (c, ...r) => { writes.push(String(c)); return origErr(c, ...r); };
    process.stdout.write = (c, ...r) => { writes.push(String(c)); return origOut(c, ...r); };
    try {
      const accounts = await enumerateAccounts({
        readActiveToken: () => null,
        listBackups: () => [{ file: "expired.json", token: "FAKE-stale", refreshToken: "FAKE-SECRET-rt" }],
      });
      expect(accounts).toEqual([]); // refresh failed → dropped
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
      globalThis.fetch = realFetch;
    }
    const all = writes.join("");
    expect(all).not.toContain("FAKE-SECRET-rt");
    expect(all).toContain("expired.json"); // file name IS allowed in the warning
  });
});
