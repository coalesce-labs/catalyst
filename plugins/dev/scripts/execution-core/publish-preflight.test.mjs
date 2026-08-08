import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePublishCapability, parseGithubSlug } from "./publish-preflight.mjs";

const root = mkdtempSync(join(tmpdir(), "publish-preflight-"));
const remote = { status: 0, stdout: "git@github.com:acme/widgets.git\n" };

test("parses SSH and HTTPS GitHub remotes", () => {
  expect(parseGithubSlug("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  expect(parseGithubSlug("https://github.com/acme/widgets.git")).toBe("acme/widgets");
});

test("push true is allowed and push false is denied with detail", () => {
  for (const [push, state] of [[true, "allowed"], [false, "denied"]]) {
    const spawn = (_cmd, args) => args[0] === "-C" ? remote : { status: 0, stdout: JSON.stringify({ push, login: "robot" }) };
    const got = probePublishCapability({ repoRoot: root, spawn, cacheDir: null });
    expect(got.state).toBe(state);
    expect(got.slug).toBe("acme/widgets");
    expect(got.detail).toContain("acme/widgets");
  }
});

test("missing gh, timeout, 404, and malformed JSON are unknown", () => {
  const cases = [
    { error: Object.assign(new Error("missing"), { code: "ENOENT" }) },
    { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    { status: 1, stderr: "HTTP 404" },
    { status: 0, stdout: "not json" },
  ];
  for (const response of cases) {
    const got = probePublishCapability({ repoRoot: root, cacheDir: null, spawn: (_cmd, args) => args[0] === "-C" ? remote : response });
    expect(got.state).toBe("unknown");
  }
});

test("fresh definitive verdict is cached; unknown is not", () => {
  let calls = 0;
  const cacheDir = join(root, "cache");
  const spawn = (_cmd, args) => {
    if (args[0] === "-C") return remote;
    calls++;
    return { status: 0, stdout: '{"push":false,"login":"robot"}' };
  };
  expect(probePublishCapability({ repoRoot: root, cacheDir, spawn, now: () => 100 }).cached).toBe(false);
  expect(probePublishCapability({ repoRoot: root, cacheDir, spawn, now: () => 101 }).cached).toBe(true);
  expect(calls).toBe(1);
  expect(readFileSync(join(cacheDir, "acme_widgets.json"), "utf8")).toContain("denied");

  let unknownCalls = 0;
  const noCache = join(root, "unknown-cache");
  const badSpawn = (_cmd, args) => {
    if (args[0] === "-C") return remote;
    unknownCalls++;
    return { status: 1, stderr: "network" };
  };
  probePublishCapability({ repoRoot: root, cacheDir: noCache, spawn: badSpawn });
  probePublishCapability({ repoRoot: root, cacheDir: noCache, spawn: badSpawn });
  expect(unknownCalls).toBe(2);
});
