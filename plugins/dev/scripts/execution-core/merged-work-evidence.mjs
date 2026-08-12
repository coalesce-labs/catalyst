// CAT-45: shared answer to "did this ticket's work merge?".
// Local ancestry only establishes that work exists; it never proves that work
// is unmerged because this repository squash-merges and deletes branches.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MERGED_WORK_VERDICTS = Object.freeze([
  "merged", "no-work", "no-work-expected", "unmerged",
  "unverifiable-transient", "unverifiable-infrastructure",
]);

const positiveMs = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function command(cmd, args, timeout) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: String(r.stdout ?? "").trim() };
}

function json(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function decideDoneWrite({ evidence, mode = "shadow", override = null, verified = null }) {
  if (verified) return { decision: "verified", reason: String(verified), evidence, mode };
  if (override) return { decision: "override", reason: String(override), evidence, mode };
  if (!evidence || evidence.ok === true) return { decision: "allow", reason: evidence?.reason ?? null, evidence, mode };
  return { decision: mode === "enforce" ? "refuse" : "would-refuse", reason: evidence.reason, evidence, mode };
}

export function resolveMergedWorkEvidence(ticket, options = {}) {
  const ghCalls = { value: 0 };
  const result = (verdict, ok, reason, extra = {}) => ({ verdict, ok, reason, ghCalls: ghCalls.value, recorded: true, ...extra });
  const orchDir = options.orchDir ?? process.env.CATALYST_ORCHESTRATOR_DIR;
  const repoRoot = options.repoRoot;
  if (!ticket || !repoRoot) return result("unverifiable-infrastructure", true, "repo-root-unavailable");

  const worker = orchDir ? join(orchDir, "workers", ticket) : null;
  const mergedSignal = worker ? json(join(worker, "phase-monitor-merge.json")) : null;
  if (mergedSignal?.pr?.mergeCommitSha || mergedSignal?.pr?.mergedAt)
    return result("merged", true, "local-merge-record", { workEvidence: "present" });

  const branchHint = options.branchHint;
  const candidates = [...new Set([branchHint, ticket].filter(Boolean))];
  let branch = null;
  let ahead = 0;
  try {
    for (const candidate of candidates) {
      for (const ref of [`refs/heads/${candidate}`, `refs/remotes/origin/${candidate}`]) {
        const exists = command("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", ref], positiveMs("MERGED_WORK_GIT_TIMEOUT_MS", 5000));
        if (exists.status !== 0) continue;
        branch = candidate;
        const count = command("git", ["-C", repoRoot, "rev-list", "--count", `origin/main..${ref}`], positiveMs("MERGED_WORK_GIT_TIMEOUT_MS", 5000));
        if (count.status !== 0) return result("unverifiable-infrastructure", true, "git-unreadable");
        ahead = Number(count.stdout) || 0;
        break;
      }
      if (branch) break;
    }
  } catch {
    return result("unverifiable-infrastructure", true, "git-unavailable");
  }
  const archivedWork = worker && existsSync(join(worker, "phase-implement.json"));
  if ((!branch || ahead === 0) && !archivedWork) return result("no-work", true, "no-local-work", { workEvidence: "absent" });

  const triage = worker ? json(join(worker, "triage.json")) : null;
  if (["docs", "chore"].includes(String(triage?.classification ?? "").toLowerCase()))
    return result("no-work-expected", true, "no-work-expected", { workEvidence: "present", branch });

  if (!process.env.PATH || !command) return result("unverifiable-infrastructure", true, "runtime-unavailable");
  try {
    ghCalls.value++;
    const remote = command("git", ["-C", repoRoot, "remote", "get-url", "origin"], positiveMs("MERGED_WORK_GIT_TIMEOUT_MS", 5000));
    const slug = remote.stdout.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1];
    if (!slug) return result("unverifiable-infrastructure", true, "github-repo-unavailable", { workEvidence: "present", branch });
    const r = command("gh", ["pr", "list", "--repo", slug, "--head", branch ?? ticket, "--state", "all", "--json", "number,state,mergedAt", "--limit", "5"], positiveMs("MERGED_WORK_GH_TIMEOUT_MS", 15000));
    if (r.status !== 0) return result("unverifiable-transient", false, "github-query-failed", { workEvidence: "present", branch });
    const prs = JSON.parse(r.stdout || "[]");
    if (prs.some((p) => String(p.state).toUpperCase() === "MERGED" || p.mergedAt))
      return result("merged", true, "github-merged-pr", { workEvidence: "present", branch });
    return result("unmerged", false, "committed-work-has-no-merged-pr", { workEvidence: "present", branch });
  } catch {
    return result("unverifiable-transient", false, "github-unavailable", { workEvidence: "present", branch });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [ticket, repoRoot, orchDir, branchHint] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(resolveMergedWorkEvidence(ticket, { repoRoot, orchDir, branchHint })) + "\n");
}
