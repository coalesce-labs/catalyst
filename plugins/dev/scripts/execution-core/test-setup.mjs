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

// Pin CATALYST_LAYER2_CONFIG_FILE the same way, and for the same reason: unset,
// getLayer2ConfigPath() falls back to the REAL ~/.config/catalyst/config.json —
// which, on any actual fleet host (a developer's live Catalyst install, not a
// clean CI runner), is a genuine machine-local config with a real multi-host
// catalyst.cluster.staticRoster. A test that never overrides this env var then
// silently becomes "multi-host" and picks up real HRW ownership filtering in
// schedulerTick's ready.filter() — e.g. a ticket id that doesn't happen to hash
// to this host gets dropped from `ready` and a "dispatches new work" assertion
// fails, on this host only, for a reason that has nothing to do with the code
// under test. Point at a guaranteed-absent path so getLayer2ConfigPath() always
// resolves the "missing Layer-2 file" branch by default. Tests that want their
// own Layer-2 fixture still set CATALYST_LAYER2_CONFIG_FILE themselves; the
// existing save/restore pattern (save current value, delete/set for the test,
// restore in afterEach) already handles a pinned non-undefined default the same
// way it handles CATALYST_DIR's hermetic pin.
process.env.CATALYST_LAYER2_CONFIG_FILE = join(hermeticDir, "layer2-config-absent.json");

// CAT-154: pin CLAUDE_CONFIG_DIR for the same reason as the Layer-2 pin above. Unset,
// claudeConfigDir() (doctor.mjs:5004) falls back to the REAL ~/.claude — so doctor's skills-dir
// check grades the developer's live Catalyst install instead of the code under test. Its severity
// is class-conditional (doctor.mjs:5089: worker→FAIL, developer→WARN) and runDoctor returns only
// the FAIL count, so the divergence is INVISIBLE locally and hard-red on a clean CI runner: that
// is how main went red for ~11h on 2026-08-09 (PR #2664 in, PR #3180 out). Point at a
// guaranteed-absent path so every host resolves the same symlink-lookup branch. Tests that want a
// real tree inject the seam (installChecksForClass's skillsDirCheck) or checkSkillsDirPlugins's
// six IO seams directly — both already the established pattern.
//
// SCOPE, precisely: this pin covers the ONE reader that honors it, `defaultSkillLink`. Three
// sibling inputs to the same check still read real host state regardless of this line —
// `defaultReadClaudeSettings` (doctor.mjs:1502) and `defaultReadInstalledPlugins` (:5056) hardcode
// `homedir()/.claude` instead of `claudeConfigDir()`, and `defaultWrapperRcFiles` (:5066) reads the
// real `~/.zshrc`/`~/.bashrc`. So this is a partial hermeticity fix, not a total one: if
// `expectedPlugins` ever resolves empty, the verdict is decided entirely by those unpinned readers
// and can still diverge dev-Mac vs CI. Closing that is CAT-248 (a production change to doctor.mjs,
// deliberately out of scope for this test-only branch). Do not read this pin as "the skills-dir
// check is now host-independent" — it is not.
process.env.CLAUDE_CONFIG_DIR = join(hermeticDir, "claude-config-absent");
// Stable record of the pin, mirroring CATALYST_HERMETIC_DIR above: sibling tests may legitimately
// overwrite and restore CLAUDE_CONFIG_DIR mid-suite (bun runs the suite in one process), so the
// record is the invariant and the live var is not. Assertions about the pin key off this.
process.env.CATALYST_HERMETIC_CLAUDE_CONFIG_DIR = join(hermeticDir, "claude-config-absent");

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
