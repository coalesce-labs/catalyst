# Dispatch — launching a relay-ticket session

## Launching `/relay-ticket <TICKET>` IS the dispatch

There is no daemon and no pull-based scheduler to hand a ticket to — both retired 2026-08-24 (CTL-2218).
You dispatch by launching a session that runs `/relay-ticket <TICKET>` yourself (a background agent /
`claude --bg` session — whatever your environment's session primitive is). Three shapes, from the
`relay-ticket` skill:

```
/relay-ticket CTC-NNN                 # do the next missing phase, produce its artifact, report, STOP
/relay-ticket CTC-NNN --through merge # keep going, phase after phase, until merged or genuinely blocked
/relay-ticket CTC-NNN --phase plan    # force a specific phase (re-run after a rejected report)
```

⛔ **Never do the phase work yourself.** No hand-edited product code, no worktree you commit into
directly, no phase agent you drive by hand. If you find yourself wanting to touch code, the thing you
actually want is a launched relay-ticket session.

## Cap at free slots

Dispatch in **priority order**, capped at how many concurrent sessions you can actually track. Launching
twenty relay-ticket sessions when you can only watch nine does not make them go faster; it makes the
queue unreadable and the holds invisible.

## ⛔ A cap is never silent

**Every ticket that was ready and was not dispatched is named, with the reason.** The reader of your plan
comment cannot tell *held deliberately* from *never looked at* — only you can, and only in the moment.

| held | why |
| -- | -- |
| CTC-438 | largest new surface on the provisioning path the rehearsal walks today; ready in substance, wrong day |
| CTC-55 | ⛔ its ACs target a retired app — needs re-scoping; I did not rewrite someone else's ticket unasked |
| CTC-439 | first scenario stalls on a copy decision that is the human's; the deliverability half could split out |

## Announce the dispatch on the ticket

A top-level comment on each ticket you launch a session for: that it was dispatched, by whom, why it was
judged ready, the trap in its ACs if there is one, and an explicit **"ask me in this thread, do not stall
silently."**

⚠️ **Say "launched by `steward/<scope>` via relay-ticket."** State moves a phase makes still write with
the host's personal token in places, so an unattributed comment can read as the human's. See the
threading reference.

## Phase-completion evidence

This is what you check **between** relay-ticket invocations to confirm a phase actually happened, before
you dispatch the next one — the RELAY REPORT is one session's *claim*; the artifact it names is the
*proof*, and when the two disagree the artifact wins (relay-ticket's own principle: artifacts on disk and
in GitHub/Linear ARE the pipeline state).

Re-read the specific artifact the report cites, matched to relay-ticket's phase-detection table:

| phase | phase-completion evidence |
| -- | -- |
| research / plan | the cited `thoughts/shared/research\|plans/*<TICKET>*.md` file exists and reads as a real document, not a stub |
| implement | `git log origin/main..origin/<TICKET>` shows commits, AND the report's gate tail is a real `bun run check` pass, not summarized as one |
| validate | a recorded verdict, not just a claim of "looks fine" |
| pr | an actual open PR for the branch (`gh pr view`), with the real number the report cites |
| merge | `gh pr view <n> --json state,mergedAt` read back yourself — never the report's word alone, and never a merge command's exit code alone |

A report that says `DONE` with no matching artifact, or a `gate:` line you cannot verify, is not
phase-completion evidence — it is BLOCKED until you can confirm it, whatever the report's own verdict
says. This is the same discipline `merge-pr` already applies to a single PR; here it applies to every
phase of every ticket you are coordinating.

## State what you cannot enforce

If your dispatch note asks a relay-ticket session to hold something — a merge, a surface, an ordering —
and you have no gate that enforces it, **say that in the same breath**. "I have no merge gate and cannot
enforce this" turns a false guarantee into an honest request, and lets whoever depends on it plan for the
miss.
