// test-setup.mjs — bun [test].preload (loaded once before every *.test.mjs in
// this package). Makes the execution-core suite HERMETIC against Linear:
//
// The leak (proxy audit: 868 real Linear calls + real `issues update --status`
// WRITES from `bun test`) comes from FIVE default exec seams, one of which is a
// CHILD SHELL — linear-write.mjs → ../linear-transition.sh → bare `linearis`.
// An in-process JS mock cannot reach that bash process, so the guard MUST be at
// the env/PATH level: child processes inherit process.env (modified PATH + the
// deleted tokens) through spawnSync, so every `linearis`/`claude` invocation —
// JS spawnSync OR child shell — resolves to the fake binaries in __tests__/fake-bin
// and never touches the network.
//
// The SAME leak class exists for GitHub: production code shells `gh` (work-done
// probes, scheduler PR-merged adapter, scan-adapters, worktrees) so a test that
// reaches a default `gh` exec seam would flood the real GitHub API. The fake
// `gh` on PATH + the unset GITHUB_TOKEN/GH_TOKEN close that the same way.
//
// Three layers, defence in depth:
//   1. PATH-shim: front PATH with fake `linearis`/`claude`/`gh` (records + benign JSON).
//   2. Token unset: even if a real binary is somehow reached, no creds → no write.
//   3. CATALYST_TEST flag: a tripwire other guards/tests can assert on.
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const fakeBin = join(import.meta.dir, "__tests__", "fake-bin");
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

// CTL-810: pin CATALYST_DIR to a fresh per-run temp dir so no test — and no
// code under test reaching a default appendEvent/emitReapIntent seam (e.g.
// recovery.test.mjs reclaim branches that never injected the emit seam) — can
// append to the REAL ~/catalyst/events/YYYY-MM.jsonl. 69% of the prod event
// log (194,544 lines) was CTL-9/bg-9 fixture pollution before this guard.
// Tests that want their own scratch still set CATALYST_DIR themselves; the
// common save/restore pattern now restores to this hermetic default instead
// of falling back to the real ~/catalyst. CATALYST_HERMETIC_DIR is the stable
// record of the pin (asserted by test-setup.test.mjs) — sibling tests mutate
// CATALYST_DIR mid-suite, but nothing may touch the record.
const hermeticDir = mkdtempSync(join(tmpdir(), "catalyst-hermetic-"));
process.env.CATALYST_DIR = hermeticDir;
process.env.CATALYST_HERMETIC_DIR = hermeticDir;

// Belt: a real linearis reached despite the shim writes nothing without creds.
delete process.env.LINEAR_API_TOKEN;
delete process.env.LINEAR_API_KEY;

// Same belt for GitHub: a real `gh` reached despite the shim has no creds →
// it can only error, never mutate a real PR/issue or flood the GitHub API.
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

// Tripwire flag (clear attribution for any in-JS guard or assertion).
process.env.CATALYST_TEST = "1";

// Where the fake binaries record every invocation (the leak surface). Cleared
// once per `bun test` run so the log reflects exactly this run's leaks.
const log = join(import.meta.dir, "__tests__", ".fake-bin-invocations.log");
process.env.CATALYST_FAKE_BIN_LOG = log;
try {
  writeFileSync(log, "");
} catch {
  // best-effort — a missing __tests__ dir just means no log this run
}
