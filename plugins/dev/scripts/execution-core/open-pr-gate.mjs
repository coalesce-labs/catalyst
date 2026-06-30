// open-pr-gate.mjs — CTL-1157 open-PR ENUMERATOR (single source of truth).
//
// "Which open/unmerged PRs does this ticket still have?" — the FACTS that the
// senior-engineer recovery-pass delegate reads before it declares a ticket Done,
// and that the two pure-code backstops (scheduler.mjs `terminalDoneOnce`, the
// reconciler drain) consult to decide whether to fire the
// `recovery.done-applied-with-open-pr` alarm.
//
// THE REVERSAL (owner's decision): this module does NOT refuse a write. It is a
// data source, not a mechanical block. The earlier fail-closed "gate that refuses"
// behavior was the handcuff that got removed — the delegate is a senior engineer
// with autonomy: it enumerates the open PRs and reasons about EACH (finish/merge
// the ones that are part of the solution; CLOSE the abandoned/superseded ones
// itself), THEN marks Done. The hard block is held in reserve. Callers DECIDE what
// to do with this list.
//
// Authoritative open-state source is GitHub (`gh`), NEVER the local cache — a
// cache lag must never misreport a PR as merged. The ticket's branchName (the
// "non-standard branch" net) and its Linear ATTACHMENTS (linked PRs) are read from
// the local Catalyst-Cloud REPLICA/cache via `catalyst-linear read`
// (source:replica) — NEVER bare `linearis` (rate-limited; stalls the fleet).
//
// Returns { ok:true,  prs:[] }            when no unmerged PR remains
//         { ok:false, prs:[…] }           when ≥1 open PR exists
//         { ok:false, reason, prs:[] }     when the GitHub check itself could not run.
// `ok` is now ADVISORY ("are there zero open PRs?"), retained for back-compat with
// callers/tests; it no longer implies any refusal.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// readTicketReplica — read a ticket's record from the local REPLICA/cache via
// `catalyst-linear read <TICKET>` (replica-first; the CLI itself degrades to its
// own linearis fallback only internally — this module NEVER shells `linearis`
// directly). Best-effort: any failure returns null. Shared by branchName +
// attachment derivation so they pay a single spawn.
export function readTicketReplica(ticket, { cwd } = {}) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sibling = join(here, "..", "catalyst-linear");
    const bin = existsSync(sibling) ? sibling : "catalyst-linear";
    const r = spawnSync(bin, ["read", ticket], {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
    });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// defaultDeriveBranchName — resolve a ticket's Linear branchName from the replica.
// Best-effort: null on any failure (the branch-head pass is simply skipped).
export function defaultDeriveBranchName(ticket, { cwd, read = readTicketReplica } = {}) {
  try {
    return read(ticket, { cwd })?.branchName ?? null;
  } catch {
    return null;
  }
}

// PR_URL_RE — pull a GitHub PR number out of a `.../pull/<n>` URL.
const PR_URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i;

// defaultDeriveAttachmentPrNumbers — CTL-1157 (Path 2 / slice 4): enumerate the
// ticket's PRs from LINEAR'S OWN attachments / linked-PR records via the replica.
// This is the third discovery source, UNIONed with the gh ticket-key search and
// the branch-head pass — it catches a PR that has NO ticket key in its title/body
// AND a non-standard head branch, but that IS attached to the Linear issue (the
// common GitHub<>Linear auto-link). Best-effort: returns a number[] of PR numbers
// parsed from any attachment whose url/href/subtitle points at a `/pull/<n>`.
//
// KNOWN RESIDUAL (documented, not a logic bug): a PR with ZERO discoverable
// linkage — no ticket key in its text, a non-standard head branch, AND no Linear
// attachment — is genuinely undiscoverable from data. All three of our sources key
// off SOME recorded linkage; an orphan PR records none. That is an
// input-completeness limit, not a gap in this enumerator.
export function defaultDeriveAttachmentPrNumbers(ticket, { cwd, read = readTicketReplica } = {}) {
  try {
    const rec = read(ticket, { cwd });
    if (!rec) return [];
    // Tolerate several shapes the replica may expose: an `attachments` array (Linear
    // GraphQL nodes), a `prLinks`/`pullRequests` array, or `attachments.nodes`.
    const atts = []
      .concat(rec.attachments?.nodes ?? rec.attachments ?? [])
      .concat(rec.pullRequests?.nodes ?? rec.pullRequests ?? [])
      .concat(rec.prLinks ?? []);
    const nums = new Set();
    for (const a of atts) {
      if (a == null) continue;
      // A plain number / numeric string is taken as a PR number directly.
      if (typeof a === "number" && Number.isFinite(a)) {
        nums.add(a);
        continue;
      }
      const hay = [a.url, a.href, a.sourceUrl, a.subtitle, a.title, typeof a === "string" ? a : null]
        .filter(Boolean)
        .join(" ");
      const m = PR_URL_RE.exec(hay);
      if (m) nums.add(Number(m[1]));
    }
    return [...nums];
  } catch {
    return [];
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

// defaultCheckOpenPrs — the enumerator. UNIONs THREE discovery passes so an open
// PR is caught by ANY of: its ticket-key mention, its head branch, or its Linear
// attachment.
//   1. ticket-key search  — `gh pr list --search <TICKET> --state open`
//   2. branch-head pass    — `gh pr list --head <branchName> --state open` (branch
//      derived from the replica when not supplied — catches a PR whose text omits
//      the key).
//   3. attachment pass     — for each PR number from Linear's attachments (replica)
//      not already seen, `gh pr view <n>` and include it iff still OPEN (catches a
//      PR with neither the key nor a matching branch, but linked in Linear).
// `--state open` ⇒ every returned PR is unmerged-and-open. `runGh` /
// `deriveBranchName` / `deriveAttachmentPrNumbers` are injectable seams for tests.
export function defaultCheckOpenPrs(
  ticket,
  {
    branchName,
    cwd,
    deriveBranchName = defaultDeriveBranchName,
    deriveAttachmentPrNumbers = defaultDeriveAttachmentPrNumbers,
    runGh,
  } = {}
) {
  const gh = runGh || ((args) => defaultRunGh(args, cwd));
  const fields = "number,state,isDraft,title";
  // Resolve a branchName for the head pass — derive from the replica/cache when not
  // supplied (NEVER bare linearis). Derivation failure ⇒ head pass skipped.
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
    // Pass 3: Linear-attachment PRs (best-effort). Confirm OPEN state via gh so a
    // merged/closed attachment never falsely counts. A view failure for one PR is
    // swallowed (that single PR is just not added) — it must not turn the whole
    // enumeration unverifiable.
    let attachmentNums = [];
    try {
      attachmentNums = deriveAttachmentPrNumbers(ticket, { cwd }) || [];
    } catch {
      attachmentNums = [];
    }
    for (const n of attachmentNums) {
      if (seen.has(n)) continue;
      let view;
      try {
        view = gh(["pr", "view", String(n), "--json", fields]);
      } catch {
        continue; // undiscoverable state for this one attachment — skip, don't fail
      }
      // `gh pr view --json` returns a single object (not an array).
      const pr = Array.isArray(view) ? view[0] : view;
      if (pr && pr.number != null && String(pr.state).toUpperCase() === "OPEN") {
        seen.set(pr.number, pr);
      }
    }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), prs: [] };
  }
  const prs = [...seen.values()];
  return { ok: prs.length === 0, prs, branchName: head ?? null };
}
