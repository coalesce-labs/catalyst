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

// CTL-1612 round 11 (Codex P2 follow-up): the CATALYST_LAYER2_CONFIG_FILE pin
// above seals the mint's own credential read, but getLivenessAnchorIssue()
// (execution-core/config.mjs) checks CATALYST_LIVENESS_ANCHOR_ISSUE env
// FIRST, unconditionally, before ever consulting Layer-2 — an ambient export
// of that var (a real dev/CI shell running the broker/execution-core, same
// class of machine already confirmed to have real orchestrator creds during
// this round's remediation) makes a direct createServer() suite resolve a
// REAL anchor issue regardless of the Layer-2 pin, and the immediate poll's
// readAnchor closure then reaches the real heartbeat CLI — a genuine POST to
// Linear's GraphQL endpoint, even with an empty/no token (it just fails
// there instead of never being attempted). Clearing it here makes
// getLivenessAnchorIssue() return null unconditionally (Layer-2 already
// sealed, env now absent too), which makes readAnchor structurally
// unreachable regardless of source (peer-liveness.mjs's `!anchorIssue`
// early return, CTL-1612 round 3) — the anchor tier can never fire, no
// matter what CATALYST_LIVENESS_READ_SOURCE resolves to.
//
// Also cleared for the SAME hermeticity reason, audited alongside it:
// CATALYST_LIVENESS_READ_SOURCE (an ambient "linear" would force anchor-only
// mode — moot once the anchor issue itself is cleared above, but a test
// suite's resolved liveness TRANSPORT should never depend on the runner's
// ambient shell state either) and CATALYST_LOKI_QUERY_URL (the analogous
// exposure for the OTHER poll transport — an ambient real Loki endpoint
// would make the same background poll reach a live Loki server instead of
// Linear; same class of "ambient env makes a hermetic test non-hermetic"
// risk, a different backend).
//
// CTL-1612 round 13 (Codex P2 follow-up): CATALYST_LOKI_QUERY_URL is only
// getLokiQueryUrl()'s EXPLICIT tier (execution-core/config.mjs) — clearing it
// alone doesn't seal the getter. Its fallback tier derives a Loki URL from
// OTEL_EXPORTER_OTLP_ENDPOINT (port swapped to 3100), and that env var is
// exactly as ambient on a real dev/CI host running the OTel collector as the
// other vars cleared above. Left uncleared, a direct createServer() suite on
// such a host still resolves a live Loki URL via that fallback and the
// AUTO-mode poll's synchronous reader either contacts the real backend or
// eats its ~8s timeout per suite — un-cached, so it repeats every run.
// Audited getLokiQueryUrl() itself for any other derivation input: it reads
// only these two env vars (no third tier), so this closes the getter fully.
delete process.env.CATALYST_LIVENESS_ANCHOR_ISSUE;
delete process.env.CATALYST_LIVENESS_READ_SOURCE;
delete process.env.CATALYST_LOKI_QUERY_URL;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

// Tripwire flag, mirroring execution-core/broker's own test-setup.mjs — clear
// attribution for any in-JS guard or assertion that wants to check it ran.
process.env.CATALYST_TEST = "1";
