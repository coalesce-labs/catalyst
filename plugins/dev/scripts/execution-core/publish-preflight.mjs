// publish-preflight.mjs — CAT-60. Three-state, cached repository push-permission probe.
// Only a definitive permissions.push=false is "denied"; every operational or
// parsing failure is "unknown" so a transient GitHub failure cannot stop work.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLISH_PROBE_TIMEOUT_MS = 10_000;
export const PUBLISH_VERDICT_TTL_MS = 60 * 60 * 1000;
export const PUBLISH_UNKNOWN_TTL_MS = 60 * 1000;

export function parseGithubSlug(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const value = remoteUrl.trim().replace(/\.git$/, "");
  const match = value.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function run(spawn, command, args, options) {
  const result = spawn(command, args, options);
  return result && typeof result === "object" ? result : {};
}

function cachePath(cacheDir, slug, pushRemote, login) {
  const key = `${slug}__${pushRemote}__${login ?? "unknown"}`;
  return join(cacheDir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function configString(path, selector) {
  if (!path) return null;
  try {
    const value = selector(JSON.parse(readFileSync(path, "utf8")));
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch { return null; }
}

export function resolvePushRemote({ repoRoot, env = process.env, layer1Path, layer2Path, spawn = nodeSpawnSync } = {}) {
  let candidate = env?.CATALYST_PUSH_REMOTE
    || configString(layer2Path, (c) => c?.catalyst?.pr?.pushRemote)
    || configString(layer1Path, (c) => c?.catalyst?.pr?.pushRemote);
  if (!candidate && repoRoot) {
    const upstream = run(spawn, "git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { env, encoding: "utf8" });
    if (upstream.status === 0) candidate = String(upstream.stdout || "").trim().split("/")[0];
  }
  if (!candidate || /[^A-Za-z0-9._/-]/.test(candidate)) return "origin";
  const exists = run(spawn, "git", ["-C", repoRoot, "remote", "get-url", candidate], { env, encoding: "utf8" });
  return exists.status === 0 ? candidate : "origin";
}

export function probePublishCapability({
  repoRoot,
  pushRemote = "origin",
  cacheDir,
  env = process.env,
  now = Date.now,
  spawn = nodeSpawnSync,
  timeoutMs = PUBLISH_PROBE_TIMEOUT_MS,
  ttlMs = PUBLISH_VERDICT_TTL_MS,
  unknownTtlMs = PUBLISH_UNKNOWN_TTL_MS,
} = {}) {
  try {
    if (!repoRoot) return { state: "unknown", slug: null, login: null, detail: "repo root unavailable", cached: false };
    const remote = run(spawn, "git", ["-C", repoRoot, "remote", "get-url", pushRemote], {
      env, encoding: "utf8", timeout: timeoutMs,
    });
    const slug = remote.status === 0 ? parseGithubSlug(remote.stdout) : null;
    if (!slug) return { state: "unknown", slug: null, login: null, detail: "push remote slug unavailable", cached: false };

    const identity = run(spawn, "gh", ["api", "user", "--jq", ".login"], { env, encoding: "utf8", timeout: timeoutMs });
    const login = identity.status === 0 ? String(identity.stdout || "").trim() || null : null;
    const file = cacheDir ? cachePath(cacheDir, slug, pushRemote, login) : null;
    if (file) {
      try {
        const cached = JSON.parse(readFileSync(file, "utf8"));
        const age = Number(now()) - Number(cached.ts);
        const cacheTtl = cached.state === "unknown" ? unknownTtlMs : ttlMs;
        if (["allowed", "denied", "unknown"].includes(cached.state) && age >= 0 && age < cacheTtl) {
          return { ...cached, cached: true };
        }
      } catch { /* corrupt/missing cache => live probe */ }
    }

    const result = run(spawn, "gh", ["api", `repos/${slug}`, "--jq", "{push:.permissions.push,owner:.owner.login}"], {
      env, encoding: "utf8", timeout: timeoutMs,
    });
    if (result.error || result.status !== 0) {
      const verdict = { state: "unknown", slug, login, detail: result.error?.message || String(result.stderr || "probe failed").trim(), ts: Number(now()) };
      if (file) try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify(verdict)); } catch { /* optimization */ }
      return { ...verdict, cached: false };
    }
    let body;
    try { body = JSON.parse(String(result.stdout || "")); } catch { return { state: "unknown", slug, login: null, detail: "unparseable GitHub response", cached: false }; }
    if (typeof body?.push !== "boolean") return { state: "unknown", slug, login, detail: "GitHub response omitted permissions.push", cached: false };
    const verdict = {
      state: body.push ? "allowed" : "denied",
      slug,
      login,
      owner: body.owner ?? null,
      detail: body.push ? `push allowed on ${slug}` : `push denied on ${slug} for ${login ?? "unknown identity"}`,
      ts: Number(now()),
    };
    if (file) {
      try {
        mkdirSync(cacheDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(verdict));
        renameSync(tmp, file);
      } catch { /* cache is an optimization */ }
    }
    return { ...verdict, cached: false };
  } catch (err) {
    return { state: "unknown", slug: null, login: null, detail: err?.message ?? "probe threw", cached: false };
  }
}
