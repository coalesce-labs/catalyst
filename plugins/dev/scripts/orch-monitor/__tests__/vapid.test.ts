import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadOrCreateVapidKeys } from "../lib/vapid";

describe("loadOrCreateVapidKeys", () => {
  let dir: string;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "vapid-test-"));
    return join(dir, "vapid.json");
  };
  const teardown = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  it("generates a keypair on first call and writes it to disk", () => {
    const path = setup();
    try {
      const keys = loadOrCreateVapidKeys(path);
      expect(typeof keys.publicKey).toBe("string");
      expect(keys.publicKey.length).toBeGreaterThan(0);
      expect(typeof keys.privateKey).toBe("string");
      expect(keys.privateKey.length).toBeGreaterThan(0);
      expect(existsSync(path)).toBe(true);
    } finally {
      teardown();
    }
  });

  it("returns the SAME keys on a second call (no regeneration)", () => {
    const path = setup();
    try {
      const first = loadOrCreateVapidKeys(path);
      const second = loadOrCreateVapidKeys(path);
      expect(second.publicKey).toBe(first.publicKey);
      expect(second.privateKey).toBe(first.privateKey);
    } finally {
      teardown();
    }
  });

  it("public key is a non-empty base64url string", () => {
    const path = setup();
    try {
      const { publicKey } = loadOrCreateVapidKeys(path);
      // base64url chars: A-Z a-z 0-9 - _  (no + / =)
      expect(publicKey).toMatch(/^[A-Za-z0-9\-_]+$/);
    } finally {
      teardown();
    }
  });

  it("written file is mode 0o600 (owner-read/write only)", () => {
    const path = setup();
    try {
      loadOrCreateVapidKeys(path);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      teardown();
    }
  });

  it("written JSON is parseable and has publicKey + privateKey fields", () => {
    const path = setup();
    try {
      loadOrCreateVapidKeys(path);
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      expect(raw).toBeTruthy();
      const obj = raw as Record<string, unknown>;
      expect(typeof obj.publicKey).toBe("string");
      expect(typeof obj.privateKey).toBe("string");
    } finally {
      teardown();
    }
  });
});
