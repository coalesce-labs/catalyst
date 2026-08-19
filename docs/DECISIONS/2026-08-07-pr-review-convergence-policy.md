# PR review convergence policy

## Decision

Apply a four-tier round-based schedule to every iterative bot/human code-review loop on a PR
(Codex, CodeRabbit, human reviewers). Track the round **per reviewer** (per bot login, or per
human reviewer) — not one counter shared across all reviewers on the PR. A PR can have more than
one active reviewer, and collapsing their counts into one shared number misclassifies a second
reviewer's genuinely-first-look findings as if they arrived at whatever round the busiest reviewer
has already reached.

- **Rounds 1-5** (per reviewer): fix everything reasonable, P1 and P2 alike. No ticket filing yet.
- **Rounds 6-15**: fix P1 findings inline as usual. For genuinely new (or reopened) P2-or-lower
  findings, don't fix inline — file or append to a single follow-up ticket for this PR, with the
  finding pasted verbatim (reviewer's exact wording, file:line). Reply on the review thread linking
  the ticket, then resolve the thread.
- **Rounds 16-25**: ticket both P1 and P2 findings by default, using the same
  verbatim-finding/single-ticket mechanics — UNLESS the P1 is critical (security vulnerability,
  data loss/corruption, broken build/tests) or blocks the PR's own stated purpose outright (it
  literally can't do the thing it exists to do without this fix). Those still get fixed inline
  regardless of round. When genuinely unsure whether a P1 clears that bar, fix it inline rather
  than ticket it.
- **Round 25 is a hard stop**: escalate to a human rather than opening a 26th round unilaterally.

A finding that was already raised in an earlier round and simply never got fixed (omitted, or the
fix didn't actually land) is still owed from that round — it does not become newly eligible for
ticketing just because it resurfaces in a later round. Ticketing is for genuinely new or reopened
findings, not a way for an incomplete earlier-round fix to escape via a later round's looser rules.

One follow-up ticket per PR, not one per finding — append later rounds' deferred findings to the
same ticket.

## Why

Chasing progressively finer findings across review rounds burns real time without moving
correctness forward — a PR can cycle far past what's reasonable over formatting and naming
preferences while review attention drifts away from whatever actually blocks merge. The four-tier
schedule front-loads full attention (rounds 1-5), tightens what's owed inline as rounds accumulate
(6-15, 16-25), and forces human escalation rather than unbounded looping (round 25). Bounding what
each subsequent tier demands inline gives a PR a monotonically shrinking blocker list — it
converges toward mergeable instead of oscillating.

## Severity definitions

**P1 (fix every round, until round 16, where only critical/blocking P1 survives the
ticket-by-default rule):** correctness bugs, security vulnerabilities, data loss/corruption, broken
build or tests, spec/contract violations — anything that would block merge on its own merits.

**P2-and-lower (ticket after round 5):** style, naming, structure/simplification preferences,
unverified micro-optimizations, documentation nits, subjective "nice to have" suggestions.

Classify by substance, not by the reviewer's own label — many bots use "P2" for an ordinary real
correctness bug, not a style nit. Reconcile against the definitions above. Only defer to an
explicit tag when its vocabulary maps cleanly onto blocking-vs-not (e.g. `critical`/`blocking` →
P1, `minor`/`nit`/`suggestion` → P2). When genuinely unsure, treat it as P1 — the failure mode to
avoid is silently deferring a real bug.

## Local review gate

Before pushing a fix round and consuming a real reviewer round-trip, run the equivalent review
locally first and iterate until clean. If the reviewer is Codex, that's:

```bash
codex exec review --base main       # full branch diff vs. base
codex exec review --uncommitted     # just staged/unstaged/untracked
```

Treat local findings with the same severity/round mechanics as remote ones. This doesn't replace
the remote check — it's still required and still the authoritative round counter — it just means
the remote round should usually come back clean, so a round that does find something is genuinely
new signal, not something a first local look would have caught for free.

## Collision awareness

Round-based reasoning assumes one worker driving one PR through its review loop. It breaks down
the moment a second session or worker is independently active on the same PR — "round N" stops
meaning anything coherent once two threads are pushing fixes and re-triggering reviews out of sync
with each other. Before starting a review-fix round:

- Check for signs another session is already active on this PR (recent commits you didn't make, an
  in-flight push, a teammate/session announcing work on the same PR/ticket). In the Catalyst
  orchestrator, this is `broker_claim_pr` — claim the PR before working it; if the broker reports
  it's already claimed by another session, that's your signal.
- If you detect one, don't race it. Pause and coordinate (hand off, split scope explicitly, or
  stand down) before pushing another fix round, or go do other work and revisit once the collision
  is resolved. Never assume the other session will notice and back off first.

## Communication guardrails win

Filing a ticket in the repo's own tracker and replying on a PR review thread are
development-workflow actions, not "outbound communication" in the sense of no-email/no-social-post
guardrails — but if a repo's guardrail is written broadly enough to make that genuinely ambiguous,
don't guess: hand off to a human.

## What this does NOT do

- **Does not mean P2 findings get ignored.** They land in a real ticket, not silently dropped — the
  trade is "fixed later, deliberately" instead of "fixed now, chased indefinitely."
- **Does not relax P1 handling before round 16.** Every round through 15 still fixes every P1
  finding it sees; round 16+ still fixes critical/blocking P1s regardless.
- **Does not override a human reviewer's explicit CHANGES_REQUESTED.** That still needs the
  reviewer's own sign-off, not just a filed ticket.

## Rollout

Adopted fleet-wide 2026-08-07 (two-tier: round 1 unrestricted, round 2+ defers new P2-or-lower).
**Revised 2026-08-19**: expanded to the four-tier schedule above (adds rounds 6-15 / 16-25 /
round-25 hard-stop distinctions, a mandatory local-review gate before each push, and the
collision-awareness section), after real-world review loops kept running past what a two-tier
schedule usefully bounded. Round counting is explicitly per-reviewer as of this revision (the
2026-08-07 version described a single shared counter as the ideal with per-tool approximation
allowed; per-reviewer counting is now the standard, not an approximation, matching what the
Catalyst pipeline already did in practice).

Implemented in the Catalyst orchestrator's `review-comments` and `phase-review` skills
(round-tracking plus follow-up-ticket filing) and stated as house policy in every
HagaleTechnologies repo's CLAUDE.md/AGENTS.md. Where a repo's bot reviewer (e.g. Codex) reads
`AGENTS.md` specifically rather than `CLAUDE.md`, the pointer is mirrored there too (or `AGENTS.md`
is a symlink to `CLAUDE.md`, per this fleet's standing convention) — a bot reviewer that never sees
the instructions can't follow them.
