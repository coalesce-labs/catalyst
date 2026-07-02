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
// Returns { ok:true,  prs:[] }                          when no unmerged PR remains
//         { ok:false, prs:[…] }                         when ≥1 open PR exists
//         { ok:false, unverifiable:true, reason, prs }  when the authoritative GitHub
//           check could NOT be completed — a `gh` list/view failure, OR the ticket's
//           repo could not be derived (so we refuse to run gh in the wrong repo).
//           UNVERIFIABLE ≠ CLEAN: an unverifiable authoritative check is never a clean
//           list. Callers/backstops MUST treat it as "could not confirm zero open PRs"
//           — surface it / fire the alarm — and never assume an empty list. (`prs` may
//           carry the PRs discovered before the failure; the load-bearing field is
//           `unverifiable`.)
// `ok` is ADVISORY ("are there zero open PRs?"), retained for back-compat with
// callers/tests; it no longer implies any refusal.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectConfig, ownerRepoFromRepoRoot } from "./registry.mjs";

// CTL-1157 F #7 (Codex round-4): a finite cap on every enumeration subprocess. In
// production `defaultCheckOpenPrs` runs on the SYNCHRONOUS terminal sweep before the
// Done-write/alarm path, so a `gh` (or `catalyst-linear`) invocation hung on network,
// auth, or keychain state would block the whole scheduler tick indefinitely — this
// enumeration is best-effort observability and must never wedge the tick. A timeout
// fire makes spawnSync set r.error (ETIMEDOUT) + r.status=null: the gh path throws →
// defaultCheckOpenPrs collapses it to {unverifiable:true} (never a false clean list);
// the replica read is best-effort → null. Env-overridable; "0" disables the cap.
const ENUM_SUBPROCESS_TIMEOUT_MS = (() => {
  // CTL-1157 (Codex round-6): guard the EMPTY/whitespace case. Number("") and
  // Number("  ") are 0 (NOT NaN), which would pass the isFinite && >=0 test and
  // silently DISABLE the cap (spawnSync timeout:0 = no limit) — reintroducing the
  // scheduler-tick wedge this cap exists to prevent. A set-but-empty env var
  // (CATALYST_OPEN_PR_GATE_TIMEOUT_MS= in an env file) is the plausible misconfig.
  // Treat a blank value as UNSET → the 15s default; only an explicit non-blank numeric
  // literal (including "0" to intentionally disable) is honored.
  const rawStr = process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS;
  if (rawStr == null || String(rawStr).trim() === "") return 15_000;
  const raw = Number(rawStr);
  if (Number.isFinite(raw) && raw >= 0) return raw; // explicit 0 → disabled (no timeout)
  return 15_000;
})();

// readTicketReplica — read a ticket's record via `catalyst-linear read <TICKET>`.
// Best-effort: any failure returns null.
//
// CTL-1157 (Codex round-7): `withAttachments` adds `--with-attachments`. The replica's
// normalized detail does NOT carry Linear attachments, and catalyst-linear only bypasses
// to the attachment-capable LIVE read when that flag is present — so the branch-name path
// (replica-only, cheap) MUST NOT set it, but the attachment-discovery path MUST, or the
// whole Linear-attachment pass is inert and a PR linked only as an attachment (no
// ticket-key mention, non-matching branch) is missed → a false-clean open-PR check. This
// is a live read, but it is bounded (timeout below) and only runs on the attachment pass.
export function readTicketReplica(ticket, { cwd, withAttachments = false } = {}) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sibling = join(here, "..", "catalyst-linear");
    const bin = existsSync(sibling) ? sibling : "catalyst-linear";
    const args = withAttachments ? ["read", ticket, "--with-attachments"] : ["read", ticket];
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      timeout: ENUM_SUBPROCESS_TIMEOUT_MS, // CTL-1157 F #7: same synchronous-tick wedge risk
    });
    // best-effort: a timeout sets r.status=null → falls into the null return below.
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// teamOf — "CTL-123" → "CTL". The registry key that resolves a ticket to its
// project repo. Null for anything not <prefix>-<n>. (Inlined here rather than
// imported from dispatch.mjs to keep this enumerator off the daemon-heavy
// dispatch import graph — it must stay loadable from the plain-node reconcile CLI.)
const TEAM_RE = /^([A-Za-z][A-Za-z0-9_]*)-[0-9]+$/;
function teamOf(ticket) {
  const m = TEAM_RE.exec(ticket ?? "");
  return m ? m[1] : null;
}

// defaultDeriveRepoRoot — resolve a ticket's project repoRoot from the
// execution-core REGISTRY (the `.catalyst` project config: team → repoRoot),
// NEVER bare linearis (rate-limited; stalls the fleet) and never the Linear API.
// The gh enumeration runs in THIS cwd so a multi-repo / per-project install
// queries the ticket's OWN repository — not the daemon's process cwd, which would
// report zero open PRs for tickets whose PRs live in a different repo. Best-effort:
// null on a malformed ticket, a missing registry entry, or any read failure.
export function defaultDeriveRepoRoot(ticket) {
  try {
    const team = teamOf(ticket);
    if (!team) return null;
    return getProjectConfig(team)?.repoRoot ?? null;
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

// PR_URL_RE — pull the (owner, repo, number) out of a `github.com/<owner>/<repo>/pull/<n>`
// URL. CTL-1157 (GROUP-3 #1): the owner/repo are load-bearing — an attached PR lives
// in the repo NAMED BY ITS URL, which in a multi-repo install is NOT necessarily the
// ticket's project repo. Capturing them lets the attachment pass `gh pr view -R
// <owner/repo>` against the PR's OWN repo instead of the ticket repo (where the same
// number could be a different PR, or absent → a false clean).
const PR_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;

// defaultDeriveAttachmentPrs — CTL-1157 (Path 2 / slice 4 + GROUP-3 #1): enumerate
// the ticket's PRs from LINEAR'S OWN attachments / linked-PR records via the replica,
// preserving each PR's OWN GitHub repo. This is the third discovery source, UNIONed
// with the gh ticket-key search and the branch-head pass — it catches a PR that has
// NO ticket key in its title/body AND a non-standard head branch, but that IS attached
// to the Linear issue (the common GitHub<>Linear auto-link). Best-effort: returns
// `{owner, repo, number}[]` — `owner`/`repo` are non-null when parsed from a full
// `/<owner>/<repo>/pull/<n>` URL, and null for a bare numeric attachment (no recorded
// cross-repo linkage → treated as the ticket's own repo by the caller).
//
// KNOWN RESIDUAL (documented, not a logic bug): a PR with ZERO discoverable
// linkage — no ticket key in its text, a non-standard head branch, AND no Linear
// attachment — is genuinely undiscoverable from data. All three of our sources key
// off SOME recorded linkage; an orphan PR records none. That is an
// input-completeness limit, not a gap in this enumerator.
export function defaultDeriveAttachmentPrs(ticket, { cwd, read = readTicketReplica } = {}) {
  try {
    // CTL-1157 (Codex round-7): MUST request attachments — the replica omits them, so a
    // flagless read returns none and this whole pass is inert. withAttachments makes
    // catalyst-linear do the attachment-capable live read.
    const rec = read(ticket, { cwd, withAttachments: true });
    if (!rec) return [];
    // Tolerate several shapes the replica may expose: an `attachments` array (Linear
    // GraphQL nodes), a `prLinks`/`pullRequests` array, or `attachments.nodes`.
    const atts = []
      .concat(rec.attachments?.nodes ?? rec.attachments ?? [])
      .concat(rec.pullRequests?.nodes ?? rec.pullRequests ?? [])
      .concat(rec.prLinks ?? []);
    const out = [];
    const seen = new Set();
    const push = (owner, repo, number) => {
      if (!Number.isFinite(number)) return;
      // A cross-repo attachment is a DISTINCT PR from a same-numbered ticket-repo PR,
      // so key dedup by owner/repo#number when the repo is known; bare numbers by #n.
      const key = owner && repo ? `${owner}/${repo}#${number}` : `#${number}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ owner: owner ?? null, repo: repo ?? null, number });
    };
    for (const a of atts) {
      if (a == null) continue;
      // A plain number / numeric string is taken as a PR number in the ticket's repo.
      if (typeof a === "number" && Number.isFinite(a)) {
        push(null, null, a);
        continue;
      }
      // CTL-1157 F #3 (Codex round-5): a BARE numeric string ("42" / "#42") is the
      // "numeric string" case the comment promises — the replica can expose a linked PR
      // as a bare number. Without this it fell through to the URL regex (no match) and
      // was silently dropped, so a Linear-attached PR with no ticket-key mention and a
      // non-standard branch escaped the enumeration → a false-clean open-PR check.
      if (typeof a === "string") {
        const bare = a.trim().match(/^#?(\d+)$/);
        if (bare) {
          push(null, null, Number(bare[1]));
          continue;
        }
      }
      const hay = [a.url, a.href, a.sourceUrl, a.subtitle, a.title, typeof a === "string" ? a : null]
        .filter(Boolean)
        .join(" ");
      const m = PR_URL_RE.exec(hay);
      if (m) push(m[1], m[2], Number(m[3]));
    }
    return out;
  } catch {
    return [];
  }
}

// defaultDeriveAttachmentPrNumbers — back-compat: the bare PR numbers (repo dropped).
// Retained for any caller/test that only needs the numbers; the enumerator itself
// uses defaultDeriveAttachmentPrs so it can target each PR's own repo.
export function defaultDeriveAttachmentPrNumbers(ticket, opts) {
  return defaultDeriveAttachmentPrs(ticket, opts).map((p) => p.number);
}

function defaultRunGh(ghArgs, cwd) {
  const r = spawnSync("gh", ghArgs, {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    timeout: ENUM_SUBPROCESS_TIMEOUT_MS, // CTL-1157 F #7: bound the tick (0 → no cap)
  });
  if (r.error || r.status !== 0) {
    // A timeout fire sets r.error.code === "ETIMEDOUT" (r.status null); surface it
    // explicitly so the unverifiable reason is diagnosable rather than a bare "exit null".
    const timedOut = r.error?.code === "ETIMEDOUT";
    const detail = timedOut
      ? `timed out after ${ENUM_SUBPROCESS_TIMEOUT_MS}ms`
      : (r.stderr || r.error?.message || `exit ${r.status}`).toString().trim();
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
//   3. attachment pass     — for each PR from Linear's attachments (replica) not
//      already seen, `gh pr view <n> -R <owner/repo>` against the ATTACHMENT'S OWN
//      repo (CTL-1157 GROUP-3 #1) and include it iff still OPEN (catches a PR with
//      neither the key nor a matching branch, but linked in Linear — possibly in a
//      DIFFERENT repo than the ticket's project repo).
// `--state open` ⇒ every returned PR is unmerged-and-open. `runGh` /
// `deriveBranchName` / `deriveAttachmentPrs` are injectable seams for tests.
export function defaultCheckOpenPrs(
  ticket,
  {
    branchName,
    cwd,
    deriveBranchName = defaultDeriveBranchName,
    deriveAttachmentPrs = defaultDeriveAttachmentPrs,
    deriveRepoRoot = defaultDeriveRepoRoot,
    runGh,
  } = {}
) {
  // Resolve the cwd the REAL gh calls run in so the enumeration queries the
  // TICKET's repository, not the daemon's process cwd (multi-repo / per-project
  // correctness — CTL-1157). An explicit `cwd` wins; otherwise derive the repoRoot
  // from the registry (the `.catalyst` project config, NEVER bare linearis). When
  // we must spawn real gh (no `runGh` seam injected) and cannot pin a repo, the
  // check is UNVERIFIABLE — running in the wrong repo would falsely report zero
  // open PRs and let a backstop mark Done with no alarm. (When `runGh` is injected,
  // the test controls gh entirely and the repo cwd is moot.)
  let repoCwd = cwd;
  if (!runGh && !repoCwd) {
    try {
      repoCwd = deriveRepoRoot(ticket) || null;
    } catch {
      repoCwd = null;
    }
    if (!repoCwd) {
      return { ok: false, unverifiable: true, reason: "repo-underivable", prs: [] };
    }
  }
  const gh = runGh || ((args) => defaultRunGh(args, repoCwd));
  const fields = "number,state,isDraft,title";
  // Resolve a branchName for the head pass — derive from the replica/cache when not
  // supplied (NEVER bare linearis). Derivation failure ⇒ head pass skipped.
  let head = branchName;
  if (!head) {
    try {
      head = deriveBranchName(ticket, { cwd: repoCwd });
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
    // Pass 3: Linear-attachment PRs. Confirm OPEN state via gh so a merged/closed
    // attachment never falsely counts. Deriving the attachments is best-effort (a
    // derivation failure just means we have no attachment hints).
    let attachmentPrs = [];
    try {
      attachmentPrs = deriveAttachmentPrs(ticket, { cwd: repoCwd }) || [];
    } catch {
      attachmentPrs = [];
    }
    // CTL-1157 (Codex round-6): the ticket's OWN GitHub "owner/repo", so a same-repo
    // attachment URL dedups against the bare-number key the ticket-key/head list passes
    // used (they ran in the ticket repo and key by p.number). Null when underivable
    // (explicit cwd / non-registry path) → the sameRepo test is false → the old
    // owner/repo#n keying stands (over-report, never under-report). NEVER bare linearis.
    let ticketRepoSlug = null;
    try {
      ticketRepoSlug = ownerRepoFromRepoRoot(repoCwd) || null;
    } catch {
      ticketRepoSlug = null;
    }
    for (const item of attachmentPrs) {
      // Normalize both shapes: an object carries the attachment's OWN (owner/repo,
      // number) parsed from the GitHub URL; a bare number means "PR <n> in the
      // ticket's own repo" (no cross-repo linkage recorded).
      const isObj = typeof item === "object" && item !== null;
      const n = isObj ? Number(item.number) : Number(item);
      if (!Number.isFinite(n)) continue;
      const owner = isObj ? item.owner ?? null : null;
      const repo = isObj ? item.repo ?? null : null;
      const repoSlug = owner && repo ? `${owner}/${repo}` : null;
      // Dedup key: a CROSS-repo attachment is a DIFFERENT PR than a same-numbered PR
      // caught by the ticket-repo list/head passes (keyed by bare number), so key it by
      // owner/repo#number. But an attachment in the ticket's OWN repo IS that same PR —
      // CTL-1157 (Codex round-6): key it by the bare number too so a single same-repo
      // open PR isn't counted twice (which would inflate open_prs_at_done + the alarm).
      // A bare-number attachment already shares the numeric key.
      const isCrossRepo = repoSlug != null && repoSlug !== ticketRepoSlug;
      const key = isCrossRepo ? `${repoSlug}#${n}` : n;
      if (seen.has(key)) continue;
      // Target the attachment's OWN repo (-R owner/repo) so a multi-repo / #-collision
      // does NOT check <n> in the ticket repo and falsely report it closed/absent (a
      // false clean). A bare number stays in the ticket-repo cwd (its recorded repo).
      const viewArgs = ["pr", "view", String(n), "--json", fields];
      if (repoSlug) viewArgs.push("-R", repoSlug);
      let view;
      try {
        view = gh(viewArgs);
      } catch (err) {
        // CTL-1157: an attachment-linked PR we KNOW exists (Linear recorded it) but
        // cannot view — a transient GitHub/auth/rate-limit failure, OR a repo we are
        // not authorized against — makes the whole enumeration UNVERIFIABLE. We cannot
        // confirm this PR is merged/closed, so the list is NOT a clean "zero open PRs".
        // Swallowing the error and returning {ok:true,prs:[]} here would let a backstop
        // mark Done with NO alarm on an unverified check. Surface it instead — never
        // silently drop the PR (nor collapse it to the ticket repo).
        const label = repoSlug ? `${repoSlug}#${n}` : `#${n}`;
        return {
          ok: false,
          unverifiable: true,
          reason: `attachment PR ${label} view failed: ${err?.message || String(err)}`,
          prs: [...seen.values()],
          branchName: head ?? null,
        };
      }
      // `gh pr view --json` returns a single object (not an array).
      const pr = Array.isArray(view) ? view[0] : view;
      if (pr && pr.number != null && String(pr.state).toUpperCase() === "OPEN") {
        // Annotate the resolving repo so a caller keying by (repo,number) can
        // disambiguate a cross-repo open PR (scheduler composite key, CTL-1157).
        if (repoSlug && pr.repo == null) pr.repo = repoSlug;
        seen.set(key, pr);
      }
    }
  } catch (err) {
    // An authoritative gh list/view pass failed — the enumeration is UNVERIFIABLE,
    // never a clean list. CTL-1157 (Codex round-6): PRESERVE the PRs already discovered
    // by an EARLIER pass (e.g. the ticket-key search found open PRs, then the head pass
    // threw) — return [...seen.values()], matching the attachment-view failure path
    // above. Returning [] here would make the pure-code Done paths emit openPrsAtDone:0
    // + an alarm with no PR numbers even though known-open PRs exist.
    return {
      ok: false,
      unverifiable: true,
      reason: err?.message || String(err),
      prs: [...seen.values()],
      branchName: head ?? null,
    };
  }
  const prs = [...seen.values()];
  return { ok: prs.length === 0, prs, branchName: head ?? null };
}
