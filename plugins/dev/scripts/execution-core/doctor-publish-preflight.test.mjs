import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRepoPushPermission, runDoctor } from "./doctor.mjs";

const verdict = (state, extra = {}) => ({
  state, slug: "coalesce-labs/catalyst", login: "octocat", detail: state, cached: false, ...extra,
});
const check = (state, mode = "shadow", extra = {}) => checkRepoPushPermission({
  repoRoot: "/repo", pushRemote: "fork", resolveMode: () => mode,
  probe: () => verdict(state, extra),
})[0];

describe("checkRepoPushPermission (CAT-60)", () => {
  test("allowed is PASS and names slug and resolved remote", () => {
    const got = check("allowed");
    expect(got.status).toBe("pass");
    expect(got.detail).toContain("coalesce-labs/catalyst");
    expect(got.detail).toContain("fork");
  });

  test("denied in shadow is WARN and does not affect runDoctor exit code", async () => {
    const fn = () => checkRepoPushPermission({ resolveMode: () => "shadow", probe: () => verdict("denied") });
    expect((await fn())[0].status).toBe("warn");
    expect(await runDoctor({ checks: [fn], log: () => {}, resolveClass: () => ({ recognized: true, class: "worker" }) })).toBe(0);
  });

  test("denied in enforce is FAIL", () => expect(check("denied", "enforce").status).toBe("fail"));
  test("unknown is INFO and never FAIL", () => expect(check("unknown", "enforce").status).toBe("info"));

  test("fresh probe cache is reused without a gh call", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "doctor-publish-"));
    let ghCalls = 0;
    const spawn = (cmd) => {
      if (cmd === "git") return { status: 0, stdout: "git@github.com:coalesce-labs/catalyst.git\n" };
      ghCalls += 1;
      return { status: 0, stdout: '{"push":true,"login":"octocat"}' };
    };
    const deps = { repoRoot: "/repo", cacheDir, spawn, now: () => 1000, resolveMode: () => "shadow" };
    expect(checkRepoPushPermission(deps)[0].status).toBe("pass");
    expect(checkRepoPushPermission(deps)[0].status).toBe("pass");
    expect(ghCalls).toBe(1);
  });

  test("all messages qualify permission as push/publish", () => {
    for (const state of ["allowed", "denied", "unknown"])
      expect(check(state).detail).toMatch(/push permission|publish/i);
  });
});
