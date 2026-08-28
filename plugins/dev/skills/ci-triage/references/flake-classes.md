# Flake classes — classify by SHAPE, not by name

The single biggest classification error in this repo's history is matching a flake by its CASE
NAME. The orphan-sweep pid-collision flake (below) rotated through `T98+T99b`, `T89`+`T100b`, and
`T97` across different runs of the _same_ PR — a monitor keyed on literal `T98|T99b` misclassified
a same-mechanism occurrence as a new, real failure. Match the MECHANISM described below, not the
test identifier it happened to land on this time. After checking these five, also grep
`thoughts/shared/learnings/` for `ci`/`flake`/`test` tags — this list is not exhaustive, and a
new occurrence belongs there once confirmed (leave that curation to `catalyst-dev:ticket-compound`;
this skill only reads).

## 1. spawn-EAGAIN false red

**Shape:** a `Failed:`/summary-style line claiming N failures, with NO matching `FAIL`/`✕`/
assertion-error line anywhere in the log for any of them. **Mechanism:** the test runner's own
child-process spawning transiently hit `EAGAIN` (resource exhaustion under CI's uncapped
concurrency — see class 3) and the harness surfaced that as a generic failure count instead of a
real per-test result. **Confirm:** re-run once before treating the count as real; if the re-run
produces actual named failures, reclassify from there.

## 2. Orphan-sweep fixture-pid collision (CTL-1701)

**Shape:** `__tests__/orphan-sweep.test.sh` fails on `execution-core-unit-tests`, almost always as
"N passed, 2 failed" (2 of ~206 cases), in code the PR doesn't touch. **Mechanism:** the suite's
cap-fixture hardcodes pids `2101-2105`; on a Linux CI runner those numbers can collide with real
live pids in the runner's own process space, and whichever assertion happens to sit on the
collided pid reds — case name is effectively random per run. **Confirm:** the failure is confined
to this one suite, the count is small (~2 of ~206), and it never reproduces locally on macOS (pid
ranges don't overlap there). **Action:** re-run the job (`gh run rerun --failed`) — ticketed,
tracked, expected to clear.

## 3. First-touch timeout under CI contention

**Shape:** a test that is the FIRST caller (in file/suite order) of an expensive, memoized,
uncached computation times out on CI but passes comfortably in isolation or locally.
**Mechanism:** this repo's CI deliberately excludes itself from the local fleet-concurrency cap, so
`turbo run test:coverage` runs every workspace's suite fully concurrently on a standard runner —
real CPU contention, not a logic bug. Confirmed case: `apps/index-host/test/wiki-augment.test.ts`
(CTC-928, run 33180922045) — the first test to pay the cost of a full-repo AST scan hit a 150000ms
budget while a sibling CONTROL test's comment already documented "consistently over 150s ... under
300s" for a _cheaper_ uncached pass, and a same-code re-run of the same commit passed on its own.
**Confirm:** (a) the failing test/file is untouched by the PR's diff, (b) an isolated or retried
run of the same commit passes, (c) the test does real uncached CPU-bound work with a budget that
doesn't leave headroom vs. a documented/measured cost. **Action:** if the margin is provably thin
(a sibling test's own comment documents the real cost), bumping the timeout with an inline citation
of the measurement is a legitimate REAL fix, not a flake dodge — don't just re-run forever.

## 4. readdir-order nondeterminism

**Shape:** intermittent failure with no code change, where the code or test under scrutiny
enumerates a directory (`readdir`/`fs.readdirSync`/a glob) and assumes a stable order.
**Mechanism:** directory listing order is not guaranteed by the filesystem and can differ between
local and CI, or between runs. This repo actively guards against it in production code — see
`plugins/dev/scripts/execution-core/scheduler.test.mjs`'s `"orders entries by mtime ... not readdir
order"` test (CTL-1660 P1) and `wt-cleanup-drain.mjs`'s explicit "stable readdir order cannot be
assumed" comment. **Confirm:** the failing assertion depends on an enumeration order the code never
explicitly sorts. **Action:** if it's a test bug (missing sort before assert), that's real — fix
the test; don't just re-run.

## 5. localStorage/window absence under bun's test runtime

**Shape:** `ReferenceError: window is not defined` or `localStorage is not defined` in a `bun test`
run touching a browser-persisted store (jotai `atomWithStorage`, etc.). **Mechanism:** `bun test`
runs in bun's own runtime, which — unlike jsdom — provides no `window`/`localStorage` global unless
a test file explicitly shims one (see `orch-monitor/ui/src/board/nav-store.test.ts`'s
`installWindowStorage()` for the pattern this repo already uses). **Confirm:** check whether the
failing test file (or a shared setup file it relies on) is supposed to install this shim and
whether the PR's diff touched that shim. **Action:** if the shim exists and is untouched, this is
CI-environment-specific and safe to re-run/isolate; if the diff removed or broke the shim, it's
real — restore it.
