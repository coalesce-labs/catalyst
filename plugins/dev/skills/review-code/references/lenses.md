# The five review lenses

Each lens is run by you, in this order, over the diff from Step 2. A lens produces *candidates* only; Step 4 confirms them. Every candidate carries `path:line` (a line the diff touched), a category — `correctness` (wrong behaviour), `security` (an exploitable weakness visible in the change), `guideline` (a quoted rule) — a one-sentence claim, and its evidence.

## 1. Guidelines — CLAUDE.md / AGENTS.md compliance

Find the guideline files that apply to each changed file: the repository root's `CLAUDE.md` and `AGENTS.md`, every `CLAUDE.md` / `AGENTS.md` in an ancestor directory of the file, and any path-scoped rule files the repository keeps (`.agents/rules/*.md`, `.claude/rules/*.md`) whose stated scope covers the file.

```bash
# from the repository root, for one changed file
f=path/to/changed.ts; d=$(dirname "$f")
while :; do for g in CLAUDE.md AGENTS.md; do [ -f "$d/$g" ] && echo "$d/$g"; done; [ "$d" = . ] && break; d=$(dirname "$d"); done
ls .agents/rules/*.md .claude/rules/*.md 2>/dev/null
```

A rule applies to a file only when the rule file's directory is an ancestor of that file (or its scope names the path). Flag only a **clear, unambiguous** violation where you can quote the exact rule being broken — the quote and its `path:line` are the evidence. A rule the code explicitly silences on that line (a lint-ignore comment, an inline "deliberate:" note) is not a violation.

## 2. Diff bugs — the shallow scan

Read the diff itself, hunk by hunk, without reaching for outside context. Flag only what the diff makes certain:

- the code will not compile or parse: a syntax error, a type error visible in the hunk, an import that was removed while a use remains, an unresolved reference, a renamed symbol with a stale caller in the same diff;
- the code will definitely produce wrong results regardless of input: an inverted condition, a wrong variable, a loop that never runs its body, a returned value ignored where it is the result, a promise dropped where its result is needed, a resource opened on the changed path and never released, a fallthrough the surrounding cases show is unintended.

If confirming the claim needs context outside the diff, keep the candidate and let Step 4 read the file. A claim that depends on specific inputs, timing or state is not certain from the diff alone — keep it as a candidate too; Step 4 confirms it (then it is a MEDIUM finding, per `scoring.md`) or drops it.

## 3. History — does the change contradict a recent, deliberate commit?

```bash
git log --no-merges -n 15 --format='%h %s' <base>..HEAD                       # the branch's own story
git log -n 10 --date=short --format='%h %ad %s' <base> -- <changed file>      # what the base did here recently
git log -n 5 --format='%h %s' -S'<a line the diff removed>' <base>            # who added the thing being removed, and why
```

Flag a candidate only when a commit subject or body names the thing the diff undoes: a guard reintroduced after a commit removed it as a bug, a fix reverted without the commit saying so, a "keep X in sync with Y" commit followed by a diff that changes X alone. The commit hash and subject are the evidence. A clean history is a normal result, not a finding.

## 4. Prior review comments — has a reviewer already asked for the opposite?

Run only when GitHub is reachable; a phase container usually has no credential, and that is fine:

```bash
gh auth status >/dev/null 2>&1 || echo "lens 4 not run: no GitHub access"
```

When it is reachable, bound the work: PR numbers come from squash-merge subjects in each changed file's recent log (`git log -n 5 --format=%s <base> -- <file> | grep -oE '#[0-9]+'`), at most five PRs in total, plus this branch's own PR if one exists (`gh pr view --json number,reviews`). For each, read the review comments on the changed files:

```bash
gh api "repos/{owner}/{repo}/pulls/<N>/comments" --jq '.[] | select(.path=="<file>") | "\(.path):\(.line // .original_line) \(.body)"'
```

A candidate is a change that re-does what a reviewer asked not to do on these lines, or leaves an accepted change request on this branch's PR unaddressed. Quote the comment. Never post anything.

## 5. In-code guidance — comments the change ignores

Within each changed file, read the comments above and around the changed hunks and at the top of the file, and search for the load-bearing markers:

```bash
grep -nE '⛔|NEVER|DO NOT|MUST NOT|MUST |invariant|@deprecated|keep (this )?in sync|load-bearing|deliberately' <changed file>
```

Flag a candidate when the change does what a nearby comment forbids, breaks a stated invariant, or changes one half of a "keep in sync" pair while the diff leaves the other half untouched. Quote the comment as the evidence.
