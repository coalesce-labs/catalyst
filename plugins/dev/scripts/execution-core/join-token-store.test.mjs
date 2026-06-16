import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DIR;
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "join-token-"));
  process.env.CATALYST_DIR = DIR;
});
afterEach(() => { delete process.env.CATALYST_DIR; });

// fresh import per test so module-level state (if any) does not leak.
const load = async () => await import(`./join-token-store.mjs?bust=${DIR}`);

describe("mintToken", () => {
  it("returns a jt_-prefixed 64-hex token and persists it", async () => {
    const { mintToken, storePath } = await load();
    const rec = mintToken();
    expect(rec.token).toMatch(/^jt_[0-9a-f]{64}$/);
    expect(existsSync(storePath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(storePath(), "utf8"));
    expect(onDisk.token).toBe(rec.token);
    expect(onDisk.consumed).toBe(false);
  });

  it("writes the store file with 0600 permissions", async () => {
    const { mintToken, storePath } = await load();
    mintToken();
    expect(statSync(storePath()).mode & 0o777).toBe(0o600);
  });

  it("a second mint overwrites the prior token (re-arm)", async () => {
    const { mintToken, readToken } = await load();
    const first = mintToken().token;
    const second = mintToken().token;
    expect(second).not.toBe(first);
    expect(readToken().token).toBe(second);
  });

  it("honors an explicit ttlMs and CATALYST_JOIN_TOKEN_TTL_MS env", async () => {
    const { mintToken } = await load();
    expect(mintToken({ ttlMs: 5000 }).ttlMs).toBe(5000);
    process.env.CATALYST_JOIN_TOKEN_TTL_MS = "1234";
    expect(mintToken().ttlMs).toBe(1234);
    delete process.env.CATALYST_JOIN_TOKEN_TTL_MS;
  });

  it("defaults to a 15-minute TTL", async () => {
    const { mintToken } = await load();
    expect(mintToken().ttlMs).toBe(15 * 60 * 1000);
  });
});

describe("isArmed / verifyToken", () => {
  it("isArmed is true for a fresh token, false with no store", async () => {
    const { mintToken, isArmed, disarm } = await load();
    expect(isArmed()).toBe(false);
    mintToken();
    expect(isArmed()).toBe(true);
    disarm();
    expect(isArmed()).toBe(false);
  });

  it("verifyToken is constant-time-correct and rejects wrong tokens", async () => {
    const { mintToken, verifyToken } = await load();
    const tok = mintToken().token;
    expect(verifyToken(tok)).toBe(true);
    expect(verifyToken("jt_" + "0".repeat(64))).toBe(false);
    expect(verifyToken("")).toBe(false);
    expect(verifyToken(null)).toBe(false);
  });

  it("isArmed is false once the TTL has elapsed", async () => {
    const { mintToken, isArmed, storePath } = await load();
    mintToken({ ttlMs: -1 });
    expect(isArmed()).toBe(false);
    const rec = JSON.parse(readFileSync(storePath(), "utf8"));
    rec.mintedAt = Date.now() - 10_000; rec.ttlMs = 1000;
    writeFileSync(storePath(), JSON.stringify(rec));
    expect(isArmed()).toBe(false);
  });
});

describe("consumeToken (single-use)", () => {
  it("succeeds exactly once, then rejects (scenario 2)", async () => {
    const { mintToken, consumeToken } = await load();
    const tok = mintToken().token;
    expect(consumeToken(tok)).not.toBeNull();
    expect(consumeToken(tok)).toBeNull();
  });

  it("marks the store consumed and isArmed false after consume", async () => {
    const { mintToken, consumeToken, isArmed, readToken } = await load();
    const tok = mintToken().token;
    consumeToken(tok);
    expect(readToken().consumed).toBe(true);
    expect(isArmed()).toBe(false);
  });

  it("rejects a consume of an expired token (scenario 3)", async () => {
    const { mintToken, consumeToken } = await load();
    const tok = mintToken({ ttlMs: -1 }).token;
    expect(consumeToken(tok)).toBeNull();
  });

  it("rejects a consume with the wrong token", async () => {
    const { mintToken, consumeToken } = await load();
    mintToken();
    expect(consumeToken("jt_" + "f".repeat(64))).toBeNull();
  });
});

describe("readToken resilience", () => {
  it("returns null on absent or malformed store", async () => {
    const { readToken, storePath } = await load();
    expect(readToken()).toBeNull();
    // cluster dir may not exist yet — create it before writing the malformed file
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), "not json{");
    expect(readToken()).toBeNull();
  });
});
