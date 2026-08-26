# Linear Sibling-Skip Guard (CTL-623 / CTL-633)

_Canonical explanation of the guard both `create-pr` and `describe-pr` call. This is the single
surviving copy of this rationale within these two skills — don't restate it, link here instead._

## The problem

A bare Linear token (`TEAM-NNN`) anywhere in a PR's branch name or body is auto-linked by Linear's
GitHub integration. For a **sibling** ticket (not the one this PR is for), that auto-link drags the
sibling's workflow status backward (e.g. Done → Implement) the moment the PR opens or merges.
Multi-ticket orchestrator branches make this common — a branch like
`o-adv-1155-1156-1157-ADV-1155` carries three sibling ticket numbers embedded in the slug.

## The rule for prose

When referencing related/sibling work in a PR description, use the sibling's **GitHub PR number**
(`#NNN`), never a bare Linear token or a Linear issue URL. The PR's own `Fixes
https://linear.app/...` line is correct and stays — that link and transition are intended; only
*sibling* references need neutralizing.

## The mechanism

Neutralization is mechanical, not something either skill hand-rolls: both source
`scripts/lib/linear-pr-skip.sh` and call one of its two mode-bound wrappers to append a
`skip <TOKEN>` guard block (Linear's documented negative magic word —
https://linear.app/docs/github) for every foreign ticket token found:

- `linear_sibling_skip_block_from_branch <own> <branch>` — walks the branch slug with the awk
  segmenter that recovers legitimate same-prefix sibling numbers from orchestrator-built names.
- `linear_sibling_skip_block_from_body <own> <body>` — canonical-token-only regex extraction, so
  prose, dates, and SHAs in a hand-written description can't fabricate a fake `skip` line.

Both modes are additionally filtered through an optional team-key allowlist cache (defense in
depth, fail-open when the cache is absent) — see the `linearis` skill's "Team-key allowlist cache
(CTL-633)" section to populate or refresh it.

Read `scripts/lib/linear-pr-skip.sh`'s header comment for the full two-mode design rationale — it
is the canonical source for *how* the guard works. This file only covers *when* and *why* each
caller invokes it.

## Call sites

- **`create-pr`** calls `_from_branch` only, at PR-creation time, against the transient
  commit-message body. Linear can auto-link on PR-open — before `describe-pr` ever runs — so the
  guard must be present in that first body too. Body-mode is skipped here: the transient body is
  assembled from commit subjects, not free-form prose, so there is nothing for body-mode to scan.
- **`describe-pr`** calls both `_from_branch` and `_from_body` at write-back time, since the
  generated description is free-form prose that may itself reintroduce a sibling token (e.g. from
  a pasted Linear relation). The two outputs are deduplicated before being appended.
