// test-setup.mjs — bun [test].preload (loaded once before every *.test.ts in
// this package). Makes the orch-monitor suite HERMETIC against a real Linear
// OAuth mint, mirroring execution-core/test-setup.mjs and broker/test-setup.mjs
// (see those files' headers for the sibling-package version of this same guard).
//
// CTL-1612 round 4 (Codex P2 follow-up, thread on server.ts:1831): createServer()
// unconditionally starts the cross-host liveness poller
// (loadDaemonDeps() → pollAnchorHeartbeats(), server.ts ~1874) UNLESS the
// caller injects a `clusterReader` option — a seam only ONE of this package's
// ~40 createServer()-calling test files (cluster-signal-endpoints.test.ts)
// actually passes. That poller's readAnchor closure fires
// remintAppActorToken() (fire-and-forget, CTL-1612 round 2/3), which mints via
// execution-core/linear-remint.mjs's REAL default readOrchestratorCreds —
// reading catalyst.linear.bot.orchestrator.{clientId,clientSecret} straight
// from the host's Layer-2 config, not from any test-injected fake. On any host
// that has both orchestrator creds AND a configured liveness anchor issue (any
// dev machine running the broker/execution-core — confirmed present on this
// machine's ~/.config/catalyst/config.json during CTL-1612 remediation), every
// `bun test` run in this package made a REAL POST to
// https://api.linear.app/oauth/token.
//
// Unlike execution-core's own test-setup.mjs (which only needs to delete
// LINEAR_API_TOKEN/LINEAR_API_KEY + shim a fake `linearis` binary, because ITS
// test suite always injects explicit readCreds/mint fakes into
// createReminter/createAsyncReminter — it never exercises the real default),
// orch-monitor's exposure is specifically through server.ts's REAL,
// un-mocked readOrchestratorCreds default, which reads Layer-2 CONFIG JSON —
// a completely different credential from LINEAR_API_TOKEN/LINEAR_API_KEY.
// Deleting those two env vars alone would not have closed this gap.
//
// CATALYST_LAYER2_CONFIG_FILE is checked FIRST in the shared secret-contract
// chain (lib/secret-contract.mjs resolveLayer2Path / catalyst-secret-contract.sh
// catalyst_secret_resolve_layer2_path), unconditionally, before
// CATALYST_MACHINE_CONFIG/XDG/~/.config — pinning it to an absent sandbox path
// seals readOrchestratorCreds with no fallback, exactly like the bash test
// suites' own CATALYST_LAYER2_CONFIG_FILE pin
// (plugins/dev/scripts/__tests__/catalyst-monitor-dist-redirect.test.sh
// run_cmd_start / orch-monitor/__tests__/catalyst-monitor.test.ts
// sandboxSecretEnv). A resolution miss is the documented fail-open contract
// (readOrchestratorCreds returns null → the reminter's attempt() is a
// no-op) — no curl, no export, byte-identical to "orchestrator app not
// configured".
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hermeticDir = mkdtempSync(join(tmpdir(), "orch-monitor-hermetic-"));
process.env.CATALYST_LAYER2_CONFIG_FILE = join(hermeticDir, "absent-layer2-config.json");

// Belt: even if some other resolution path is somehow reached, no app-actor
// (or personal) token can already be sitting in env for a test to
// accidentally rely on or leak through.
delete process.env.LINEAR_API_TOKEN;
delete process.env.LINEAR_API_KEY;
delete process.env.CATALYST_MONITOR_APP_ACTOR_TOKEN;

// Tripwire flag, mirroring execution-core/broker's own test-setup.mjs — clear
// attribution for any in-JS guard or assertion that wants to check it ran.
process.env.CATALYST_TEST = "1";
