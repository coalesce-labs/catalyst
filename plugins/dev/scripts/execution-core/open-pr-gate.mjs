// open-pr-gate.mjs — CTL-1157 deterministic open-PR Done gate (single source of truth).
//
// "Does this ticket still have an open/unmerged PR?" — the one check that EVERY
// code path which writes Linear `Done` must run, so a ticket can never be marked
// Done while a PR is still open (the owner's #1 rule; the false-positive that got
// the GitHub-PR→Done automation removed: one merged PR + one still-open PR on a
// NON-standard branch → falsely Done). Shared by the completion-declaration CLI
// (linear-reconcile-cli.mjs `declare`) AND the execution-core terminal sweep
// (scheduler.mjs `terminalDoneOnce`) so both run the IDENTICAL gate.
//
// Authoritative source is GitHub (`gh`), NEVER the local cache — a cache lag must
// never green-light a Done. The ticket's branchName (the secondary "non-standard
// branch" net) is read from the local Catalyst-Cloud REPLICA/cache via
// `catalyst-linear read` (source:replica) — NEVER bare `linearis` (rate-limited;
// stalls the fleet). FAIL-CLOSED: an unverifiable PR set (gh missing/auth/network)
// refuses the write.
//
// Returns { ok:true,  prs:[] }            when no unmerged PR remains (Done allowed)
//         { ok:false, prs:[…] }           when ≥1 open PR exists      (Done refused)
//         { ok:false, reason, prs:[] }     when the check itself could not run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// defaultDeriveBranchName — resolve a ticket's Linear branchName from the local
// REPLICA/cache via `catalyst-linear read <TICKET>` (replica-first; the CLI itself
// degrades to its own linearis fallback only internally — this module NEVER shells
// `linearis` directly). Best-effort: any failure returns null and the branch-head
// pass is simply skipped (the ticket-key search pass still runs).
export function defaultDeriveBranchName(ticket, { cwd } = {}) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sibling = join(here, "..", "catalyst-linear");
    const bin = existsSync(sibling) ? sibling : "catalyst-linear";
    const r = spawnSync(bin, ["read", ticket], {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
    });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout)?.branchName ?? null;
  } catch {
    return null;
  }
}

function defaultRunGh(ghArgs, cwd) {
  const r = spawnSync("gh", ghArgs, { encoding: "utf8", cwd: cwd || process.cwd() });
  if (r.error || r.status !== 0) {
    const detail = (r.stderr || r.error?.message || `exit ${r.status}`).toString().trim();
    throw new Error(`\`gh ${ghArgs.join(" ")}\` failed: ${detail}`);
  }
  try {
    return JSON.parse(r.stdout || "[]");
  } catch {
    throw new Error(`\`gh ${ghArgs.join(" ")}\` returned unparseable JSON`);
  }
}

// defaultCheckOpenPrs — the gate. Combines two `gh pr list --state open` passes and
// UNIONs them so an open PR is caught by EITHER its ticket-key mention OR its head
// branch:
//   1. ticket-key search  — `gh pr list --search <TICKET> --state open`
//   2. branch-head pass    — `gh pr list --head <branchName> --state open`  (ALWAYS,
//      with branchName derived from the replica/cache when the caller didn't pass
//      one — catches a PR whose title/body omits the ticket key).
// `--state open` ⇒ every returned PR is unmerged-and-open. `runGh`/`deriveBranchName`
// are injectable seams for tests.
export function defaultCheckOpenPrs(
  ticket,
  { branchName, cwd, deriveBranchName = defaultDeriveBranchName, runGh } = {}
) {
  const gh = runGh || ((args) => defaultRunGh(args, cwd));
  const fields = "number,state,isDraft,title";
  // Always resolve a branchName for the head pass — derive from the replica/cache
  // when not supplied (NEVER bare linearis). Derivation failure ⇒ head pass skipped.
  let head = branchName;
  if (!head) {
    try {
      head = deriveBranchName(ticket, { cwd });
    } catch {
      head = null;
    }
  }
  const seen = new Map();
  try {
    for (const p of gh([
      "pr",
      "list",
      "--search",
      ticket,
      "--state",
      "open",
      "--json",
      fields,
      "--limit",
      "100",
    ]))
      if (p && p.number != null) seen.set(p.number, p);
    if (head) {
      for (const p of gh([
        "pr",
        "list",
        "--head",
        head,
        "--state",
        "open",
        "--json",
        fields,
        "--limit",
        "100",
      ]))
        if (p && p.number != null) seen.set(p.number, p);
    }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), prs: [] };
  }
  const prs = [...seen.values()];
  return { ok: prs.length === 0, prs, branchName: head ?? null };
}
