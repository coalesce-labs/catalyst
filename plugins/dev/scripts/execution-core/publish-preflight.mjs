// publish-preflight.mjs — CAT-60. Three-state, cached repository push-permission probe.
// Only a definitive permissions.push=false is "denied"; every operational or
// parsing failure is "unknown" so a transient GitHub failure cannot stop work.

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLISH_PROBE_TIMEOUT_MS = 10_000;
export const PUBLISH_VERDICT_TTL_MS = 60 * 60 * 1000;

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

function cachePath(cacheDir, slug) {
  return join(cacheDir, `${slug.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
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
} = {}) {
  try {
    if (!repoRoot) return { state: "unknown", slug: null, login: null, detail: "repo root unavailable", cached: false };
    const remote = run(spawn, "git", ["-C", repoRoot, "remote", "get-url", pushRemote], {
      env, encoding: "utf8", timeout: timeoutMs,
    });
    const slug = remote.status === 0 ? parseGithubSlug(remote.stdout) : null;
    if (!slug) return { state: "unknown", slug: null, login: null, detail: "push remote slug unavailable", cached: false };

    const file = cacheDir ? cachePath(cacheDir, slug) : null;
    if (file) {
      try {
        const cached = JSON.parse(readFileSync(file, "utf8"));
        const age = Number(now()) - Number(cached.ts);
        if (["allowed", "denied"].includes(cached.state) && age >= 0 && age < ttlMs) {
          return { ...cached, cached: true };
        }
      } catch { /* corrupt/missing cache => live probe */ }
    }

    const result = run(spawn, "gh", ["api", `repos/${slug}`, "--jq", "{push:.permissions.push,login:.owner.login}"], {
      env, encoding: "utf8", timeout: timeoutMs,
    });
    if (result.error || result.status !== 0) {
      return { state: "unknown", slug, login: null, detail: result.error?.message || String(result.stderr || "probe failed").trim(), cached: false };
    }
    let body;
    try { body = JSON.parse(String(result.stdout || "")); } catch { return { state: "unknown", slug, login: null, detail: "unparseable GitHub response", cached: false }; }
    if (typeof body?.push !== "boolean") return { state: "unknown", slug, login: body?.login ?? null, detail: "GitHub response omitted permissions.push", cached: false };
    const verdict = {
      state: body.push ? "allowed" : "denied",
      slug,
      login: body.login ?? null,
      detail: body.push ? `push allowed on ${slug}` : `push denied on ${slug} for ${body.login ?? "unknown identity"}`,
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
