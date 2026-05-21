// scan-adapters.mjs — real git/gh/deploy/comms adapters for the scan CLI
// (CTL-533 Phase 4).
//
// runScan in scan.mjs is pure given injected adapters. For the `scan` CLI
// dry-run mode (and any future real integration) these adapters back those
// injection points with actual git/gh/filesystem calls. Construction is
// isolated here so index.mjs stays a thin entrypoint.
//
// All adapter methods fail soft — a git/gh error yields a null/empty result
// rather than throwing, mirroring the `|| echo ""` discipline of the bash
// scan body. The CLI mode is apply-nothing, so a soft failure just produces
// a smaller scan result.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// run — a fail-soft synchronous subprocess. Returns trimmed stdout, or "" on
// any non-zero exit / spawn error.
function run(cmd, args, opts = {}) {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
    if (res.status !== 0 || res.error) return "";
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
}

// repoSlug — parse "<owner>/<repo>" from a git remote URL.
function repoSlug(worktree) {
  const url = run("git", ["-C", worktree, "remote", "get-url", "origin"]);
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  return m ? m[1] : null;
}

// makeScanAdapters — build the adapter bundle for runScan.
//
// `worktreeFor(ticket)` resolves a worker's worktree path. The orchestrator
// convention is `${worktreeBase}/${orchId}-${ticket}`; callers may override.
export function makeScanAdapters({
  orchId,
  worktreeBase,
  configPath,
  channelFile,
}) {
  const worktreeFor = (ticket) => join(worktreeBase, `${orchId}-${ticket}`);

  const config = loadConfig(configPath);

  const git = {
    branch: (ticket) =>
      run("git", ["-C", worktreeFor(ticket), "branch", "--show-current"]),
    commitCount: (ticket) => {
      const n = run("git", [
        "-C",
        worktreeFor(ticket),
        "rev-list",
        "--count",
        "HEAD",
      ]);
      return Number(n) || 0;
    },
    remoteBranchExists: (ticket) => {
      const wt = worktreeFor(ticket);
      const branch = run("git", ["-C", wt, "branch", "--show-current"]);
      if (!branch) return false;
      const out = run("git", [
        "-C",
        wt,
        "ls-remote",
        "--heads",
        "origin",
        branch,
      ]);
      return out.length > 0;
    },
  };

  const gh = {
    prForBranch: (ticket, branch) => {
      const slug = repoSlug(worktreeFor(ticket));
      if (!slug || !branch) return null;
      const json = run("gh", [
        "-R",
        slug,
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state",
        "--limit",
        "1",
      ]);
      const arr = parseJson(json, []);
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return { ...arr[0], repo: slug };
    },
    prView: (ticket, pr) => {
      const slug = pr?.repo ?? repoSlug(worktreeFor(ticket));
      if (!slug || !pr?.number) {
        return {
          state: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          mergedAt: null,
          mergeCommitSha: null,
        };
      }
      const json = run("gh", [
        "-R",
        slug,
        "pr",
        "view",
        String(pr.number),
        "--json",
        "state,mergeStateStatus,mergedAt,mergeCommit",
      ]);
      const v = parseJson(json, {});
      return {
        state: v.state ?? "UNKNOWN",
        mergeStateStatus: v.mergeStateStatus ?? "UNKNOWN",
        mergedAt: v.mergedAt ?? null,
        mergeCommitSha: v.mergeCommit?.oid ?? null,
      };
    },
  };

  const deploy = {
    skipDeployVerification: (repo) =>
      deployField(config, repo, "skipDeployVerification", true) !== false,
    productionEnvironment: (repo) =>
      deployField(config, repo, "productionEnvironment", "production"),
    timeoutSec: (repo) => deployField(config, repo, "timeoutSec", 1800),
  };

  const comms = {
    readSince: (cursor) => readChannelSince(channelFile, cursor),
  };

  return { git, gh, deploy, comms };
}

// loadConfig — read .catalyst/config.json; {} on any failure.
function loadConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

// deployField — read catalyst.deploy[<repo>].<field> with a default.
function deployField(config, repo, field, fallback) {
  const val = config?.catalyst?.deploy?.[repo]?.[field];
  return val === undefined ? fallback : val;
}

// parseJson — JSON.parse with a fallback on any error.
function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// readChannelSince — read comms-channel JSONL messages after `cursor` lines.
function readChannelSince(channelFile, cursor) {
  const file =
    channelFile ?? join(homedir(), "catalyst", "comms", "channels");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines
    .slice(cursor)
    .map((l) => parseJson(l, null))
    .filter((m) => m !== null);
}
