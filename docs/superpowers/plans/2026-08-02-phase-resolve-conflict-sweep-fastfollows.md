# resolve-conflict-sweep Fast-Follows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the 17-item deferred punch list from the #1461 resolve-conflict-sweep build
(coalesce-labs/catalyst#1461, thagale/catalyst#15+#16 merged, coalesce-labs/catalyst#2886 open) —
comments, style cleanups, and test-coverage gaps that were reviewed and explicitly triaged as
non-blocking fast-follows, not new architecture.

**Architecture:** No new modules or behavior changes except one pure refactor (explicit switch
dispatch, Task 1 Step 3) that preserves existing outcomes byte-for-byte. Everything else is either
a comment/doc fix or a net-new test against existing, unchanged production code.

**Tech Stack:** Node test runner (`node --test`) for `.test.mjs` files; bash for `.test.sh` files.

## Global Constraints

- Repo: `~/code-repos/github/coalesce-labs/catalyst` (dev clone). `fork` remote =
  `thagale/catalyst` (push here freely). `origin` remote = `coalesce-labs/catalyst` (fetch/PR only,
  never push).
- Do NOT run any test suite with `run_in_background: true` and then end your turn waiting on it.
  Run synchronously with a 300000ms+ timeout. `scheduler.mjs`'s own test file is slow (~190s+) but
  none of these tasks touch it directly — the files touched here (`resolve-conflict-sweep.test.mjs`,
  `unstuck-sweep.test.mjs`, the two `__tests__/*.test.sh` files) are fast. Still run them
  synchronously, not backgrounded.
- Every new test must PASS before the task is considered done. Run the specific test file directly
  (not the full suite) to keep iteration fast:
  `node --test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
  `node --test plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs`
  `bash plugins/dev/scripts/__tests__/orchestrate-revive-phase.test.sh`
  `bash plugins/dev/scripts/__tests__/phase-goal-no-turn-caps.test.sh`
  `bash plugins/dev/scripts/__tests__/phase-mirror-footer.test.sh`
- Commit each task independently with a conventional commit (`fix(dev):` or `test(dev):`,
  `#1461` reference) once its own tests pass. Do not batch commits across tasks.
- These four tasks touch **disjoint files** — safe to execute in parallel, no worktree isolation
  needed.

---

### Task 1: resolve-conflict-sweep.mjs source cleanups (#1, #7, #14, #16)

**Files:**
- Modify: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs`
- Modify: `plugins/dev/scripts/execution-core/scheduler.mjs:4953` (comment only)

**Interfaces:** No exported signatures change. `classifyResolveConflictCandidate`'s return shape
(`{action, reason}`) is unchanged; only the *caller*'s branch dispatch becomes an explicit switch.

- [ ] **Step 1 (#1 — naming clarity, resolve-conflict-sweep.mjs:49-51):** The classifier's
  `cap-exhausted` decision uses `reason: "cycle-cap-exhausted"` — a different string from the
  exported `CAP_EXHAUSTED_REASON = "resolve-conflict-cycle-cap-exhausted"` constant (which is a
  *signal-field* marker value, not a decision-object reason). Confirmed non-bug, just confusing to
  a future reader who assumes they're the same string space. Add a comment directly above the
  `return { action: "cap-exhausted", reason: "cycle-cap-exhausted" };` line:

  ```js
  // NOTE: this "cycle-cap-exhausted" string is this classifier's own decision-
  // object vocabulary (report.wouldEscalate/escalated reasons), a SEPARATE
  // namespace from the exported CAP_EXHAUSTED_REASON constant below (which is
  // the value written into the SIGNAL's failureReason/stalledReason field by
  // defaultEscalateCapExhausted). Do not conflate the two when grepping.
  ```

  Do not rename the string literal — it's asserted verbatim in
  `resolve-conflict-sweep.test.mjs`'s `classifyResolveConflictCandidate` describe block.

- [ ] **Step 2 (#16 — stale comment, resolve-conflict-sweep.mjs:769-771):** The
  `runResolveConflictSweepPass` header comment still says:
  `(3) failures (status:"failed", #1461 escalation-gap fix)`. The failures collector was widened to
  match `RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES` minus `"done"` (i.e. `failed`, `stalled`,
  `turn-cap-exhausted`), not just `status:"failed"`. Update that one line to:

  ```js
  // dispatch or cap-exhausted-escalate; (2) completions (status:"done") →
  // clearStall; (3) failures (any RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES shape
  // minus "done" — failed/stalled/turn-cap-exhausted, #1461 escalation-gap fix
  // widened at classify time) → cap-exhausted-escalate or revert-and-reset-cycle.
  ```

- [ ] **Step 3 (#16 — stale comment, scheduler.mjs:4953-4955):** Same staleness in the scheduler's
  wiring comment. Currently:
  ```js
  // #1461 escalation-gap fix: a FAILED (status:"failed") resolve-conflict
  // run — census + the revert-and-reset action seam (escalateCapExhausted
  // is REUSED below for the at/over-cap outcome, same as the candidates
  // sub-pass's own cap-exhausted branch).
  ```
  Change the first line to: `// #1461 escalation-gap fix: a resolve-conflict run that lands in ANY`
  `// failure shape (failed, stalled, or turn-cap-exhausted — see`
  `// RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES) — census + the revert-and-reset action seam`
  (keep the rest of the comment as-is).

- [ ] **Step 4 (#7 — explicit branch dispatch, resolve-conflict-sweep.mjs:920-965):** The
  candidates sub-pass currently does:
  ```js
  if (decision.action === "skip") { ... continue; }
  if (decision.action === "cap-exhausted") { ... continue; }
  // mark-and-dispatch
  if (!enforce) { ... continue; }
  const result = markAndDispatch({ ... });
  ```
  `classifyResolveConflictCandidate` only ever returns `"skip"`, `"cap-exhausted"`, or
  `"mark-and-dispatch"` — mirror `unstuck-sweep.mjs`'s `_actionToEnforceEvent`/`_actionToShadowEvent`
  style (`switch` + explicit `default`) instead of falling through implicitly. Rewrite as:
  ```js
  if (decision.action === "skip") {
    report.skipped.push({ ticket: c.ticket, phase: c.phase, reason: decision.reason });
    continue;
  }

  if (decision.action === "cap-exhausted") {
    if (!enforce) {
      fire("resolve-conflict.would.escalate", { ticket: c.ticket, phase: c.phase });
      report.wouldEscalate.push({ ticket: c.ticket, phase: c.phase });
      continue;
    }
    const posted = escalateCapExhausted({ ticket: c.ticket, phase: c.phase, workerDir: c.workerDir, cycleCount });
    fire("resolve-conflict.escalated", { ticket: c.ticket, phase: c.phase, posted });
    report.escalated.push({ ticket: c.ticket, phase: c.phase });
    continue;
  }

  if (decision.action !== "mark-and-dispatch") {
    // Defensive — classifyResolveConflictCandidate's closed return set never
    // produces anything else today; a future new action value must not
    // silently fall into mark-and-dispatch.
    report.failed.push({ ticket: c.ticket, phase: c.phase, reason: `unknown classifier action: ${decision.action}` });
    continue;
  }

  if (!enforce) {
    fire("resolve-conflict.would.mark", { ticket: c.ticket, phase: c.phase });
    fire("resolve-conflict.would.dispatch", { ticket: c.ticket, phase: c.phase });
    report.wouldMark.push({ ticket: c.ticket, phase: c.phase });
    continue;
  }
  const result = markAndDispatch({ ... }); // unchanged body
  ```
  Keep every existing field/event name identical — this is a pure control-flow tightening, not a
  behavior change. `defaultCollectResolveConflictCandidates` test suite must still pass unchanged.

- [ ] **Step 5 (#14 — orchestrate-revive interaction comment, resolve-conflict-sweep.mjs:238):**
  Add a comment above `const RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES = ...` explaining the actual
  (verified, not assumed) interaction with `orchestrate-revive`'s legacy phase-mode retry sweep:

  ```js
  // Interaction with orchestrate-revive's legacy phase-mode retry sweep (#1461
  // follow-up, verified 2026-08-02): orchestrate-revive globs every
  // workers/<T>/phase-*.json, including phase-resolve-conflict.json, and its
  // CTL-607 current-phase guard computes CURRENT_PHASE via
  // lib/phase-sequence.sh's latest_phase_in_dir(), which only walks the 10
  // canonical PHASES entries (triage..teardown) — "resolve-conflict" is not one
  // of them. So P_PHASE="resolve-conflict" can NEVER equal CURRENT_PHASE, and
  // phase-resolve-conflict.json is unconditionally skipped by that guard on
  // every pass, regardless of its status. orchestrate-revive can never
  // re-dispatch or escalate this file directly.
  //
  // The ORIGINAL stalled phase's own signal (e.g. phase-implement.json) IS
  // reachable, though: while resolve-conflict-sweep is mid-cycle its
  // failureReason/stalledReason reads RESOLVED_MARKER_REASON (a non-empty
  // string), and orchestrate-revive's phase_is_truly_failed() only checks for a
  // non-empty .failureReason — it does not know this marker value is a
  // resolve-conflict-owned in-flight state, not a real failure. If
  // orchestrate-revive's phase-mode loop scans this ticket's worker dir while
  // the marker is set, it raises a spurious phase-failed-unrecoverable
  // attention item instead of a silent no-op. See
  // __tests__/orchestrate-revive-phase.test.sh Test I for both properties
  // proven directly against the real script.
  //
  // Blast radius is narrow: orchestrate-revive is invoked ONLY by the legacy
  // catalyst-legacy:orchestrate wave loop (grep confirms no execution-core
  // scheduler/daemon path calls it) — a team running dispatchMode:
  // execution-core exclusively never has this loop running against the same
  // worker dir, so the overlap only exists under a mixed/legacy deployment.
  ```

- [ ] **Step 6:** Run `node --test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
  synchronously (300000ms+ timeout). Confirm the SAME set of test names pass as before this task's
  edits (comment-only + Step 4's pure refactor must not change any pass/fail outcome). Diff test
  names against a baseline run taken before editing if unsure.

- [ ] **Step 7: Commit**
  ```bash
  git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs plugins/dev/scripts/execution-core/scheduler.mjs
  git commit -m "fix(dev): #1461 — clarify stale/confusing comments, explicit action dispatch in resolve-conflict-sweep"
  ```

---

### Task 2: resolve-conflict-sweep.test.mjs coverage gaps (#3, #4, #5, #6, #12, #15)

**Files:**
- Modify: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`

**Interfaces:**
- Consumes: `defaultCollectResolveConflictCandidates`, `defaultEscalateCapExhausted`,
  `runResolveConflictSweepPass`, `defaultRevertStallAndResetCycle`,
  `defaultCollectResolveConflictCandidates` — all already imported at the top of this test file.
  `RESOLVE_CONFLICT_STALL_REASON`, `RESOLVED_MARKER_REASON`, `RESOLVE_CONFLICT_CYCLE_CAP`,
  `CAP_EXHAUSTED_REASON` — already imported constants.

- [ ] **Step 1 (#3 — `defaultCollectResolveConflictCandidates` describe block, after the existing
  "a missing workers dir returns []" test around line 164):** Add two tests:

  ```js
  test("skips a workers/ entry that is not a valid ticket key (isTicketKey filter)", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["not-a-ticket", "CTL-5"] },
      files: {
        "/orch/workers/CTL-5": ["phase-implement.json"],
        "/orch/workers/CTL-5/phase-implement.json": JSON.stringify({
          status: "stalled",
          failureReason: "source_conflict_ctl708_unavailable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0].ticket).toBe("CTL-5");
  });

  test("a throwing resolveWorktreePath degrades to worktreePath:null (fail-closed), candidate still collected", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-6"] },
      files: {
        "/orch/workers/CTL-6": ["phase-implement.json"],
        "/orch/workers/CTL-6/phase-implement.json": JSON.stringify({
          status: "stalled",
          failureReason: "source_conflict_ctl708_unavailable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({
      orchDir,
      ...fs,
      resolveWorktreePath: () => { throw new Error("resolver exploded"); },
    });
    expect(out).toHaveLength(1);
    expect(out[0].worktreePath).toBeNull();
  });
  ```

- [ ] **Step 2 (#4 — `defaultEscalateCapExhausted` describe block, after the existing test around
  line 633):** Add a sibling test exercising the `stalledReason` field instead of `failureReason`:

  ```js
  test("marks the signal cap-exhausted via stalledReason when that field is present instead of failureReason", () => {
    const reads = { "/w/phase-implement.json": JSON.stringify({ status: "stalled", stalledReason: "source_conflict_resolvable" }) };
    const writes = [];
    const deps = {
      readFileSync: (p) => reads[p],
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: () => {},
      postComment: () => true,
    };
    const ok = defaultEscalateCapExhausted({ ticket: "CTL-1", phase: "implement", workerDir: "/w", cycleCount: 3 }, deps);
    expect(ok).toBe(true);
    const written = JSON.parse(writes[0][1]);
    expect(written.stalledReason).toBe("resolve-conflict-cycle-cap-exhausted");
    expect(written.failureReason).toBeUndefined();
  });
  ```

- [ ] **Step 3 (#5 — fix the coincidental cap-value assertion, same describe block, existing test
  at line 615):** The existing assertion `expect(posted[0][1]).toMatch(/cycle cap \(3\)/);` can't
  distinguish "correctly used the RESOLVE_CONFLICT_CYCLE_CAP constant" from "accidentally
  substituted cycleCount" because the fixture's `cycleCount: 3` happens to equal the default cap.
  Change the fixture's `cycleCount` to a DIFFERENT value (`5`) and assert both numbers appear
  distinctly:
  ```js
  const ok = defaultEscalateCapExhausted({ ticket: "CTL-1", phase: "implement", workerDir: "/w", cycleCount: 5 }, deps);
  // ...
  expect(posted[0][1]).toMatch(/cycle cap \(3\)/);       // RESOLVE_CONFLICT_CYCLE_CAP (module constant)
  expect(posted[0][1]).toMatch(/after 5 attempt\(s\)/);  // cycleCount (call argument) — now provably distinct
  ```

- [ ] **Step 4 (#6 — mixed-batch try/catch isolation, `runResolveConflictSweepPass` describe
  block, after the existing "a throwing census degrades to an empty pass" test around line 1247):**
  Add a test with TWO candidates in one `collectCandidates()` result where processing one throws
  and its sibling still succeeds:
  ```js
  test("a per-candidate throw (one ticket's cycleCountOf explodes) does not abort a sibling candidate in the same batch", async () => {
    const marked = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [
        { ticket: "CTL-BAD", phase: "implement", workerDir: "/w1", raw: { failureReason: "source_conflict_ctl708_unavailable" }, worktreePath: "/wt1", base: "main" },
        { ticket: "CTL-GOOD", phase: "implement", workerDir: "/w2", raw: { failureReason: "source_conflict_ctl708_unavailable" }, worktreePath: "/wt2", base: "main" },
      ],
      collectCompletions: () => [],
      cycleCountOf: (ticket) => { if (ticket === "CTL-BAD") throw new Error("boom"); return 0; },
      classifyLive: async () => ({ resolvable: true, conflictFiles: [], conflictTypes: [] }),
      markAndDispatch: (c) => { marked.push(c.ticket); return { success: true, dispatched: true }; },
      emit: async () => true,
    });
    expect(report.failed).toEqual([{ ticket: "CTL-BAD", phase: "implement", reason: "boom" }]);
    expect(report.marked).toEqual([{ ticket: "CTL-GOOD", phase: "implement" }]);
    expect(marked).toEqual(["CTL-GOOD"]);
  });

  test("a per-completion throw (one ticket's clearStall explodes) does not abort a sibling completion in the same batch", async () => {
    const cleared = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [],
      collectCompletions: () => [
        { ticket: "CTL-BAD", stalledPhase: "implement" },
        { ticket: "CTL-GOOD", stalledPhase: "verify" },
      ],
      clearStall: (c) => {
        if (c.ticket === "CTL-BAD") throw new Error("clear boom");
        cleared.push(c.ticket);
        return true;
      },
      emit: async () => true,
    });
    expect(report.failed).toEqual([{ ticket: "CTL-BAD", phase: "implement", reason: "clear boom" }]);
    expect(report.cleared).toEqual([{ ticket: "CTL-GOOD", phase: "verify" }]);
    expect(cleared).toEqual(["CTL-GOOD"]);
  });
  ```

- [ ] **Step 5 (#15 — `defaultRevertStallAndResetCycle` rejection branch, find its describe block
  around line 898 and add a sibling test):** No existing fixture exercises the concurrent-write
  guard's REJECTION path (M2 in the source comment) — every fixture today seeds
  `RESOLVED_MARKER_REASON`. Add:
  ```js
  test("M2 rejection: does NOT clobber the reason when a concurrent writer already changed it away from RESOLVED_MARKER_REASON", () => {
    const signalPath = "/w/phase-implement.json";
    const reads = { [signalPath]: JSON.stringify({ status: "stalled", failureReason: "resolve-conflict-cycle-cap-exhausted", bg_job_id: "abc" }) };
    const writes = [];
    const rmCalls = [];
    const ok = defaultRevertStallAndResetCycle("/orch", "CTL-1", "implement", {
      readFileSync: (p) => reads[p],
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: () => {},
      rmSync: (p) => rmCalls.push(p),
      readdirSync: () => [],
    });
    expect(ok).toBe(false);
    expect(writes).toHaveLength(0); // never wrote — the concurrent CAP_EXHAUSTED_REASON write stands
    expect(rmCalls).toHaveLength(0); // maybeResetForResolveConflictCycle never invoked (step 2 skipped)
    const untouched = JSON.parse(reads[signalPath]);
    expect(untouched.failureReason).toBe("resolve-conflict-cycle-cap-exhausted");
  });
  ```
  Adjust the exact seam names (`readFileSync`/`writeFileSync`/`renameSync`/`rmSync`/`readdirSync`)
  to match whatever this describe block's existing tests already inject — read the 3-4 tests above
  it in the file first to match the established fixture shape exactly.

- [ ] **Step 6 (#12 — true end-to-end test for the SUCCESSFUL redispatch path, new describe block
  after the existing "#1461 escalation-gap fix: real end-to-end chain" block around line 1108):**
  The existing "cycle-reset integration" describe block (line 498) only calls
  `defaultMarkAndDispatch` directly (seam-level) — there is no test driving the full
  `runResolveConflictSweepPass` → real `defaultCollectResolveConflictCandidates` →
  `defaultMarkAndDispatch` chain over a REAL filesystem for the successful-redispatch case, mirroring
  what the failure-path "I1" block (line 986) already does. Add:
  ```js
  describe("#1461 cycle-reset fix: real end-to-end successful-redispatch chain over a real filesystem (I2)", () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "resolve-conflict-redispatch-real-fs-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    test("a fresh stall behind a STALE done phase-resolve-conflict.json still gets a REAL dispatch, not a swallowed idempotent no-op", async () => {
      const orchDir = dir;
      const ticket = "CTL-9201";
      const workerDir = join(orchDir, "workers", ticket);
      mkdirSync(workerDir, { recursive: true });

      // Stale terminal signal left over from a completed FIRST cycle.
      writeFileSync(join(workerDir, "phase-resolve-conflict.json"), JSON.stringify({ status: "done", generation: 1 }));
      writeFileSync(join(workerDir, "resolve-conflict-brief.json"), JSON.stringify({ stalledPhase: "implement", attempt: 1 }));
      writeFileSync(join(workerDir, "resolve-conflict.claim.1"), "{}");
      // A genuinely NEW stall on the same original phase.
      writeFileSync(join(workerDir, "phase-implement.json"), JSON.stringify({ status: "stalled", failureReason: RESOLVE_CONFLICT_STALL_REASON }));

      // fakeDispatchLikeRealPhaseAgentDispatch mirrors phase-agent-dispatch's own
      // idempotency guard exactly (see the cycle-reset integration describe block
      // above) — reused here unmodified against a REAL fs via readFileSync/writeFileSync.
      let calls = 0;
      const dispatch = (_orchDir, _tk, phase) => {
        calls++;
        const sigPath = join(workerDir, `phase-${phase}.json`);
        let existingStatus = null;
        try { existingStatus = JSON.parse(readFileSync(sigPath, "utf8")).status; } catch { existingStatus = null; }
        if (["dispatched", "running", "done"].includes(existingStatus)) {
          return { code: 0, signal: { idempotent: true } };
        }
        writeFileSync(sigPath, JSON.stringify({ status: "dispatched", generation: calls + 1 }));
        return { code: 0, signal: { bg_job_id: `job-${calls}` } };
      };

      const report = await runResolveConflictSweepPass({
        mode: "enforce",
        collectCandidates: () => defaultCollectResolveConflictCandidates({ orchDir }),
        collectCompletions: () => [],
        collectFailures: () => [],
        cycleCountOf: () => 1,
        classifyLive: async () => ({ resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] }),
        markAndDispatch: (c) => defaultMarkAndDispatch({ ...c, orchDir }, { isThenable: () => false, dispatch }),
        emit: async () => true,
      });

      expect(report.marked).toEqual([{ ticket, phase: "implement" }]);
      expect(calls).toBe(1);
      // The dispatch genuinely fired (not idempotent) — proven by the REAL
      // phase-resolve-conflict.json now reading "dispatched", not the stale "done".
      const finalSignal = JSON.parse(readFileSync(join(workerDir, "phase-resolve-conflict.json"), "utf8"));
      expect(finalSignal.status).toBe("dispatched");
      expect(existsSync(join(workerDir, "resolve-conflict.claim.1"))).toBe(false);
    });
  });
  ```
  Check the top of the file for what's already imported from `node:fs` (`mkdtempSync`, `writeFileSync`,
  `readFileSync`, `rmSync`, `existsSync`, `mkdirSync`) and `node:os`/`node:path` (`tmpdir`, `join`) —
  the existing I1 block already uses all of these, so no new imports should be needed.

- [ ] **Step 7:** Run `node --test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
  synchronously (300000ms+ timeout). All new tests plus every pre-existing test must pass.

- [ ] **Step 8: Commit**
  ```bash
  git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs
  git commit -m "test(dev): #1461 — close resolve-conflict-sweep coverage gaps (candidates filter/fail-closed, stalledReason escalate, cap-value discrimination, mixed-batch isolation, M2 rejection, real e2e redispatch)"
  ```

---

### Task 3: orchestrate-revive-phase.test.sh — Test I (#14)

**Files:**
- Modify: `plugins/dev/scripts/__tests__/orchestrate-revive-phase.test.sh`

**Interfaces:**
- Consumes: the file's own `scratch_setup`/`scratch_teardown`, `set_repo_root_for_revive`,
  `make_per_phase_signal TICKET PHASE STATUS [EXTRA_JQ_FILTER]`, `run_revive`, `$DISPATCH_LOG`,
  `$STATE_LOG`, `$OUT_JSON` — all already defined earlier in this file (see Tests F/G/H for the
  exact usage pattern to copy).

- [ ] **Step 1:** Insert a new "Test I" block after Test H (before the final results summary,
  currently starting at line 416):
  ```bash
  # ─── Test I (#1461 follow-up): phase-resolve-conflict.json is never reachable
  # by the CTL-607 current-phase guard, but the ORIGINAL stalled phase's reused
  # RESOLVED_MARKER_REASON in .failureReason IS read by phase_is_truly_failed as
  # a genuine failure and escalated — not redispatched, not a silent no-op.
  echo "test I (#1461): resolve-conflict marker interaction with orchestrate-revive"
  scratch_setup
  WORKTREE_BASE="${SCRATCH}/worktrees"
  set_repo_root_for_revive
  make_per_phase_signal "T-RC" "implement" "stalled" '.failureReason = "source_conflict_resolvable"'
  make_per_phase_signal "T-RC" "resolve-conflict" "stalled" '.attentionReason = "sdk-backstop"'
  run_revive
  if grep -q "dispatch-called.*--phase resolve-conflict.*T-RC" "$DISPATCH_LOG"; then
    fail "resolve-conflict phase must NEVER be dispatched by orchestrate-revive" "log: $(cat "$DISPATCH_LOG")"
  else
    pass "resolve-conflict phase never dispatched (CTL-607 excludes it structurally)"
  fi
  PSNC=$(jq -r '.phaseSkippedNonCurrent' "$OUT_JSON")
  [ "$PSNC" = "1" ] \
    && pass "phaseSkippedNonCurrent == 1 (resolve-conflict skipped as non-current)" \
    || fail "phaseSkippedNonCurrent == 1" "got '$PSNC' summary: $(cat "$OUT_JSON")"
  if grep -q "T-RC.*phase-failed-unrecoverable" "$STATE_LOG"; then
    pass "documented: RESOLVED_MARKER_REASON on the original phase reads as truly-failed and escalates"
  else
    fail "expected an escalate call for T-RC/implement (RESOLVED_MARKER_REASON read as truly-failed)" "state log: $(cat "$STATE_LOG")"
  fi
  if grep -q "dispatch-called.*--phase implement.*T-RC" "$DISPATCH_LOG"; then
    fail "implement must NOT be redispatched (it escalates instead, per phase_is_truly_failed)" "log: $(cat "$DISPATCH_LOG")"
  else
    pass "implement not redispatched — escalated instead"
  fi
  scratch_teardown
  ```
  Run `bash plugins/dev/scripts/__tests__/orchestrate-revive-phase.test.sh -x` (or without `-x`) once
  first with just Test I's `make_per_phase_signal`/`run_revive` calls and inspect `$STATE_LOG` /
  `$DISPATCH_LOG` contents directly (e.g. temporarily `cat` them) to confirm the EXACT log line
  format before finalizing the `grep` patterns above — match the existing Test F/G/H convention for
  how `phase_revive_escalate`'s call to the fake `catalyst-state.sh` gets logged
  (`"$@" >> "$STATE_LOG"`), since the exact argv shape (`attention test-orch phase-failed-unrecoverable
  T-RC "phase=implement reason=..."`) determines the grep string.

- [ ] **Step 2:** Run `bash plugins/dev/scripts/__tests__/orchestrate-revive-phase.test.sh`
  synchronously. All pre-existing tests (1 through H) plus the new Test I must pass.

- [ ] **Step 3: Commit**
  ```bash
  git add plugins/dev/scripts/__tests__/orchestrate-revive-phase.test.sh
  git commit -m "test(dev): #1461 — prove orchestrate-revive/resolve-conflict-sweep interaction is bounded"
  ```

---

### Task 4: cheap wins — skill test arrays + unstuck-sweep fixture reuse (#9, #10)

**Files:**
- Modify: `plugins/dev/scripts/__tests__/phase-goal-no-turn-caps.test.sh`
- Modify: `plugins/dev/scripts/__tests__/phase-mirror-footer.test.sh`
- Modify: `plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs`

**Interfaces:** None — these are additive array entries and a fixture-reuse refactor, no exported
signatures involved.

- [ ] **Step 1 (#10a):** In `phase-goal-no-turn-caps.test.sh`, add
  `"plugins/dev/skills/phase-resolve-conflict/SKILL.md"` to the `SKILLS=(...)` array (alongside the
  existing `phase-remediate`/`recovery-pass` entries).

- [ ] **Step 2 (#10b):** In `phase-mirror-footer.test.sh`'s Test 5 loop (currently
  `for phase in research plan implement verify remediate review triage pr monitor-merge; do`), add
  `resolve-conflict` to that list.

- [ ] **Step 3:** Run both test files synchronously:
  ```bash
  bash plugins/dev/scripts/__tests__/phase-goal-no-turn-caps.test.sh
  bash plugins/dev/scripts/__tests__/phase-mirror-footer.test.sh
  ```
  Both must report the new `phase-resolve-conflict` row as PASS (confirms the punch list's own
  claim that the underlying properties already hold — it's a coverage gap, not a bug).

- [ ] **Step 4 (#9):** In `unstuck-sweep.test.mjs`, the test at line 454
  (`"finds source_conflict_ctl708_unavailable via failureReason..."`) hand-rolls inline
  `readdirSync`/`readFileSync` mocks against a literal `"/orch"` path instead of using the
  `makeWorker(ticket, signalOverrides)` fixture (defined at line 385, backed by a real `mkdtempSync`
  orchDir in this describe block's `beforeEach`) that every sibling test in this same describe block
  already uses. Replace it with:
  ```js
  test("finds source_conflict_ctl708_unavailable via failureReason (the real producer field), not just stalledReason", () => {
    makeWorker("CTL-2007", {
      status: "stalled",
      failureReason: "source_conflict_ctl708_unavailable",
      stalledReason: undefined,
    });
    const out = defaultCollectUnstuckCandidates({ orchDir });
    expect(out).toHaveLength(1);
    expect(out[0].evidence.reason).toBe("source_conflict_ctl708_unavailable");
  });
  ```
  (Ticket id bumped to `CTL-2007` to avoid colliding with the other tickets `makeWorker` already
  creates in sibling tests within the same `beforeEach`-scoped `orchDir`.) Verify
  `stalledReason: undefined` actually omits the key from the written JSON (check `makeWorker`'s
  `{...signal, ...signalOverrides}` spread — `JSON.stringify` drops `undefined`-valued keys
  natively, so this should already do the right thing; if the existing sibling test at line 407
  does the same `stalledReason: undefined` pattern, mirror it exactly).

- [ ] **Step 5:** Run `node --test plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs`
  synchronously (300000ms+ timeout). All tests must pass, including the refactored one.

- [ ] **Step 6: Commit**
  ```bash
  git add plugins/dev/scripts/__tests__/phase-goal-no-turn-caps.test.sh plugins/dev/scripts/__tests__/phase-mirror-footer.test.sh plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs
  git commit -m "test(dev): #1461 — add phase-resolve-conflict to skill regression arrays, reuse makeWorker fixture"
  ```

---

## Out of scope (left for the operator, per punch-list triage)

- **#17** (residual failure shape: pre-launch dispatch dies before ever writing
  `phase-resolve-conflict.json`) — touches `phase-agent-dispatch`'s pre-launch envelope, a wider
  blast radius than this sweep-scoped pass. File a dedicated CTL tracking ticket instead of fixing
  inline here (done directly by the orchestrating session, not a plan task).
- **#2** (`Number(env) || 3` discards an explicit `CAP=0`) and **#8** — explicitly accepted
  trade-offs per the original review; fix only if a task above happens to touch the same lines.
- **#11** (no runtime detector for a swallowed `{idempotent:true}`/`{status:"claim-lost"}` dispatch
  response) and **#13** (theoretical double-simultaneous-stall race, unreachable with the pipeline's
  current one-phase-stalls-at-a-time invariant) — genuine design questions, not crisp test
  additions; left for a future pass if the underlying scenario ever becomes reachable.
