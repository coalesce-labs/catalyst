# Report shape

The report is what the caller records, so its shape is fixed. Findings carry `path:line` where `line` is a line the diff touched in the NEW file (for a deleted file, `line` is 1 and the reason says "deleted"). Severity, category and confidence are the ones from `scoring.md`.

```markdown
## Code review results

**Review scope**: base `<base sha>` (`<base_input>`, ancestry <proven|unproven>) — <code> code files reviewed of <changed> changed; <non_code> non-code files not reviewed
**Lenses run**: guidelines, diff-bugs, history, prior-review-comments (<run | not run: no GitHub access>), in-code-guidance

### Findings (confidence ≥ 80)
- `src/relay/loop.ts:142` — HIGH — correctness — 92 — the retry counter is reset inside the loop, so the bound in the commit message is never reached.
  Evidence: the hunk at 138–145; `git show 0ab12cd` added the bound deliberately ("cap retries at 4").
  Fix: move `attempts = 0` above the loop.
- `apps/web/src/api.ts:57` — MEDIUM — guideline — 85 — a raw `fetch` to the tenant API where AGENTS.md requires the write-proxy.
  Evidence: AGENTS.md:31 — "all tenant writes go through the write-proxy, never a direct fetch".
  Fix: route through `writeProxy.post(...)`.

### Dropped candidates
- `src/relay/loop.ts:170` — "unused import" — a linter catches it (false-positive list).
- `packages/schema/src/index.ts:12` — "missing null check" — pre-existing on the base commit.

### Verdict: FAIL
2 confirmed findings (1 correctness, 1 guideline).

```catalyst-review-step
{"step":"code-review","verdict":"FAIL","detail":"2 confirmed findings: src/relay/loop.ts:142 retry bound never reached; apps/web/src/api.ts:57 direct fetch where AGENTS.md:31 requires the write-proxy","findings":[{"path":"src/relay/loop.ts","line":142},{"path":"apps/web/src/api.ts","line":57}]}
```
```

## Verdict rules

- **FAIL** — at least one finding survived Step 4 (any category: a confirmed `correctness`, `security` or `guideline` finding at ≥80 is a real defect). The `findings` array lists every one, `path` repo-relative, `line` the touched line.
- **PASS** — no finding survived. `detail` names what was checked, e.g. `"no findings at ≥80 across 5 lenses; 7 code files reviewed against <sha>"`. Never write PASS for a review you did not perform on a real diff.
- **SKIPPED** — Step 1 said `skipped`: `detail` is the script's reason (empty diff, or non-code only). No `findings`.
- **UNAVAILABLE** — Step 1 said `unavailable`, or the caller's scope block says an empty change list means the base is wrong: `detail` is that reason. No `findings`.

The `catalyst-review-step` line is one JSON object on one line, valid as written. A validate session copies it into its ladder block's `code-review` entry; a hand-run session leaves it in the report for whoever reads it. `detail` is one line naming the evidence; keep it under 500 characters.

## When the scope was unproven

If `ancestry: unproven`, say so in the scope line and keep the review; the diff is still the two-dot diff against the given base, and the caller decides how much to trust it. Do not silently widen or narrow the scope to compensate.
