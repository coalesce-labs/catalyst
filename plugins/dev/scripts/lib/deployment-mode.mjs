// deployment-mode.mjs — CTL-1617: the canonical deployment-mode resolver.
//
// WHY THIS FILE EXISTS. Today a Catalyst node's deployment topology (a lone
// laptop, a member of a coordinated cluster, or a managed-container cloud node)
// is 100% inferred from side effects — a webhook tunnel opens because a channel
// string happens to be configured, a cluster roster resolves to single-host
// purely because no cluster-repo clone exists. Nothing declares deployment mode,
// and nothing cross-checks the inferences against each other. This module is the
// ONE declared answer — `catalyst.deployment.mode` ∈ {single-host, cluster,
// cloud} — resolved identically here and in the bash mirror
// (lib/catalyst-deployment-mode.sh), consumed by every deployment-mode-dependent
// seam (webhook ingestion gating, secret-provider selection, doctor's
// roster-consistency checks).
//
// ZERO-IMPORT LEAF (node:fs / node:os / node:path only) — mirrors the
// execution-core/worker-label-names.mjs rationale: doctor.mjs runs under bare
// Node and must import this without pulling a heavier module graph
// (execution-core/config.mjs's own import chain reaches bun:sqlite via
// linear-query.mjs, which the Node ESM loader rejects at load time).
// execution-core/config.mjs re-exports these three names with a one-line
// import; orch-monitor imports this file directly (cross-directory .mjs
// import — precedent: orch-monitor/ui/src/board/process-surface.test.ts
// importing ../../../../lib/fsm-descriptor.mjs). PR1 (this file) ships with
// ZERO consumers outside its own tests — nothing outside tests may import it
// yet; wiring lands in later PRs of the CTL-1617 migration plan.
//
// NAMING RULE: always write "deployment mode" fully qualified — in every log
// line, WARN message, and comment in this file — never bare "mode". Three
// unrelated "mode" concepts already exist in this codebase
// (catalyst.orchestration.dispatchMode, the executor-derived dispatch-mode
// telemetry, readLinearReplica().mode).
//
// ENV-VS-FILE ASYMMETRY — read this before touching the escape hatch on a
// running daemon. Layer-1/Layer-2 FILE edits are picked up LIVE — every
// resolveDeploymentMode() call re-reads both files from disk. The ENV var
// (CATALYST_DEPLOYMENT_MODE) is captured into a long-lived daemon's
// process.env exactly once, at process launch — changing it in a shell
// profile or launchd plist reaches only freshly started processes. A running
// daemon keeps resolving its OLD value until it is restarted. Forgetting this
// reads as "the resolver is broken" when it is actually "the daemon needs a
// restart" — same caveat class as the dormant-by-default broker-degraded
// detector's env-gate (broker/broker-degraded.mjs).
//
// Precedent this mirrors: execution-core/config.mjs resolveNodeClass's
// validity ladder (env → Layer-2 → default), extended one layer to also read
// the committed Layer-1 default — node.class never needed a Layer-1 rung, but
// deployment mode is genuinely fleet-scoped (design §3), so Layer-1 is a
// real source here, read after Layer-2 (the per-host override still wins).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// DEPLOYMENT_MODES — the closed enum. Frozen: callers must never mutate this
// in place to add a value. A 4th "both" value was deliberately rejected
// (CTL-1617 design §2) — the provider's own webhook.delivery.id already makes
// concurrent smee+cloud ingestion dedup-safe without one.
export const DEPLOYMENT_MODES = Object.freeze(["single-host", "cluster", "cloud"]);

// The safest degradation target for every soft-failure case (unset, a
// present-but-non-string value, or an unrecognized string). Wrongly assuming
// cluster/cloud would make a node skip its own webhook ingestion or expect
// substrate that doesn't exist; wrongly assuming single-host means "act
// exactly as every host does today" — zero-config, zero-behavior-change
// (matches NODE_CLASS_DEFAULT's stated contract, execution-core/config.mjs:303).
const DEPLOYMENT_MODE_DEFAULT = "single-host";

// resolveLayer2Path — an explicit layer2ConfigPath wins; otherwise
// env.CATALYST_LAYER2_CONFIG_FILE; otherwise ~/.config/catalyst/config.json.
// Mirrors execution-core/config.mjs getLayer2ConfigPath(), but reads the
// injected `env` (not process.env directly) so the whole resolution stays
// pure and testable without mutating the real environment.
//
// PARITY DECISION — RESOLVE ~ FROM THE INJECTED ENV, NOT THE REAL PROCESS:
// the final fallback used to call node:os's homedir(), which always reads
// the REAL process's home directory regardless of what `env` a caller
// injected. A caller that supplies { env: { HOME: fixtureHome } } — the
// documented isolation contract this function's own docstring promises —
// intending to sandbox Layer-2 resolution to a fixture directory would
// instead have this fallback silently read the ACTUAL current user's
// machine config and resolve its deployment mode, ignoring the fixture
// entirely (reproduced: a cloud config under the fixture home was ignored
// in favor of the real home). Fixed by preferring env.HOME (when it is a
// non-empty string) over homedir(), so an injected env — the same mechanism
// resolveLayer1Path and the CATALYST_LAYER2_CONFIG_FILE override above
// already honor — is honored on this path too. Every production call site
// still calls resolveDeploymentMode() with no args, so env defaults to
// process.env and env.HOME is the real user's home exactly as before.
function resolveLayer2Path(env, layer2ConfigPath) {
  if (typeof layer2ConfigPath === "string" && layer2ConfigPath.length > 0) {
    return layer2ConfigPath;
  }
  const override = env?.CATALYST_LAYER2_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  return resolve(home, ".config", "catalyst", "config.json");
}

// resolveLayer1Path — an explicit layer1ConfigPath wins; otherwise
// env.CATALYST_CONFIG_FILE; otherwise cwd/.catalyst/config.json. Mirrors
// execution-core/config.mjs getCatalystRepoDir()'s CATALYST_CONFIG_FILE
// convention.
function resolveLayer1Path(env, layer1ConfigPath) {
  if (typeof layer1ConfigPath === "string" && layer1ConfigPath.length > 0) {
    return layer1ConfigPath;
  }
  const override = env?.CATALYST_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  return resolve(process.cwd(), ".catalyst", "config.json");
}

// readDeploymentModeField — pull catalyst.deployment.mode out of a config file
// EXACTLY as written (whatever JSON type). Returns undefined when the file is
// absent/malformed/unreadable OR the key is simply not present — both count
// as "nothing here, try the next layer" (the readLayer2NodeClass contract,
// execution-core/config.mjs:312-325). Never throws.
// JSON acceptance mirrors jq's ACTUAL parser (the bash mirror's engine), not an
// approximation. The earlier regex guard here over-rejected two ways the
// CTL-1616 verifier disproved empirically against jq 1.7.1:
//   - jq ACCEPTS a lone LOW surrogate escape (\uDC00-\uDFFF), substituting
//     U+FFFD — only a lone HIGH escape rejects the whole document (exit 5);
//   - a backslash run of EVEN length before `uXXXX` is literal text (the JSON
//     source `"\\ud800"` parses to the harmless 7-char string), not a live
//     escape — the old regex was blind to the run and killed the whole read.
// This scanner + toWellFormed pair is intentionally kept in lockstep with
// lib/secret-contract.mjs's identical pair (both files are zero-import leaves,
// so neither may import the other; the shared semantics are pinned by each
// file's own parity suite against the same jq binary).
function hasLiveLoneHighSurrogateEscape(text) {
  const re = /(\\+)u([0-9a-fA-F]{4})/g;
  const liveMatches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1].length % 2 !== 1) continue; // even run ⇒ literal backslashes + text
    liveMatches.push({ index: m.index, end: m.index + m[0].length, code: parseInt(m[2], 16) });
  }
  for (let i = 0; i < liveMatches.length; i++) {
    const cur = liveMatches[i];
    if (cur.code < 0xd800 || cur.code > 0xdbff) continue; // not a HIGH surrogate
    const next = liveMatches[i + 1];
    const isPaired =
      next != null && next.index === cur.end && next.code >= 0xdc00 && next.code <= 0xdfff;
    if (!isPaired) return true;
  }
  return false;
}

// toWellFormedString — a lone LOW surrogate that survives into the parsed mode
// string becomes U+FFFD, the same byte sequence jq substitutes at parse time
// (JSON.parse carries the raw lone code unit through). Applied only at the
// mode-extraction boundary.
function toWellFormedString(str) {
  if (typeof str.toWellFormed === "function") return str.toWellFormed();
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++;
      } else {
        out += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
    } else {
      out += str[i];
    }
  }
  return out;
}

function readDeploymentModeField(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    if (hasLiveLoneHighSurrogateEscape(text)) return undefined;
    const mode = JSON.parse(text)?.catalyst?.deployment?.mode;
    return typeof mode === "string" ? toWellFormedString(mode) : mode;
  } catch {
    return undefined;
  }
}

// classifyCandidate — apply the validity ladder (CTL-1617 design §4) to ONE
// layer's raw candidate. Returns { fallthrough: true } when this layer has
// nothing decisive to say (try the next layer), or { result } with a
// fully-formed resolution object when this layer settles the question
// (valid or invalid).
//
// Ladder:
//   - undefined (absent key / unreadable file / unset env) OR explicit JSON
//     null ⇒ fall through to the next layer (both are the "unset" sentinel).
//   - present but NOT a string (true, 123, [], {}) ⇒ explicit
//     misconfiguration, never silently absent ⇒ degrade to single-host,
//     recognized:false, AT this layer's source.
//   - string ⇒ ASCII-only trim + lowercase. Empty after trim ⇒ treated as
//     cleared ⇒ fall through (mirrors an empty env var). The trim is
//     DELIBERATELY narrower than String.prototype.trim(): bash [[:space:]]
//     under the C locale cannot see Unicode whitespace, and cross-language
//     parity beats Unicode hospitality — an NBSP-padded value stays a
//     non-member and degrades identically on both sides.
//   - member of DEPLOYMENT_MODES ⇒ recognized:true.
//   - non-member (typo) ⇒ degrade to single-host, recognized:false, AT this
//     layer's source — doctor FAILs until corrected.
function classifyCandidate(raw, source) {
  if (raw === undefined || raw === null) return { fallthrough: true };
  if (typeof raw !== "string") {
    return {
      result: { mode: DEPLOYMENT_MODE_DEFAULT, source, inferred: false, recognized: false, raw },
    };
  }
  const normalized = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "").toLowerCase();
  if (normalized.length === 0) return { fallthrough: true };
  if (DEPLOYMENT_MODES.includes(normalized)) {
    return { result: { mode: normalized, source, inferred: false, recognized: true, raw } };
  }
  return {
    result: { mode: DEPLOYMENT_MODE_DEFAULT, source, inferred: false, recognized: false, raw },
  };
}

// resolveDeploymentMode — the pure, no-logging resolver. Never throws.
// Precedence: env CATALYST_DEPLOYMENT_MODE → Layer-2 catalyst.deployment.mode
// → Layer-1 catalyst.deployment.mode → constant default "single-host".
// Returns { mode, source, inferred, recognized, raw }:
//   - source     ∈ "env" | "layer2" | "layer1" | "default"
//   - inferred   = true only for the constant default (no explicit value
//                  anywhere)
//   - recognized = whether the explicit value named a real deployment mode
//                  (always true for the inferred default; false is what
//                  routes doctor to FAIL)
//   - raw        = the explicit value exactly as written (for WARN/doctor text)
//
// Accepts an injectable { env, layer1ConfigPath, layer2ConfigPath } so tests
// (and the cross-stack parity fixture matrix in
// __tests__/deployment-mode-parity.test.sh) can redirect every input without
// touching process.env or the filesystem outside a fixture dir.
export function resolveDeploymentMode({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const envCandidate = classifyCandidate(env?.CATALYST_DEPLOYMENT_MODE, "env");
  if (envCandidate.result) return envCandidate.result;

  const l2Path = resolveLayer2Path(env, layer2ConfigPath);
  const l2Candidate = classifyCandidate(readDeploymentModeField(l2Path), "layer2");
  if (l2Candidate.result) return l2Candidate.result;

  const l1Path = resolveLayer1Path(env, layer1ConfigPath);
  const l1Candidate = classifyCandidate(readDeploymentModeField(l1Path), "layer1");
  if (l1Candidate.result) return l1Candidate.result;

  return { mode: DEPLOYMENT_MODE_DEFAULT, source: "default", inferred: true, recognized: true, raw: null };
}

// getDeploymentMode — the convenience accessor the rest of the system reads.
// Resolves FRESH on every call — the resolved value is never cached, only the
// dedup Set of WARN messages already emitted is (once per process), mirroring
// getNodeClass's _warnedNodeClass pattern (execution-core/config.mjs:380-396).
// Caching the resolved value would defeat the "file edits are picked up live"
// contract documented above. Hot-path callers that must stay strictly
// log-free use resolveDeploymentMode().mode directly. Never throws.
//
// Accepts the same optional { env, layer1ConfigPath, layer2ConfigPath } as
// resolveDeploymentMode (forwarded as-is) so tests can point this at an
// explicit fixture instead of the real process.env/filesystem — needed to
// deterministically exercise the WARN-dedup path (a real environment may or
// may not be in a warn-worthy state). Every production call site still calls
// getDeploymentMode() with no args, which resolves against process.env / the
// real config files exactly as before.
// printableRaw — render the offending raw value for the WARN without ever
// throwing: a template-literal `${raw}` coerces via toString, and a valid
// JSON misconfiguration like {"mode": {"toString": null}} shadows it and
// throws TypeError — which would break getDeploymentMode's never-throws
// contract on exactly the degraded path it exists to report.
function printableRaw(raw) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return "[unprintable value]";
  }
}

const _warnedDeploymentMode = new Set();
export function getDeploymentMode(opts = {}) {
  const r = resolveDeploymentMode(opts);
  let msg = null;
  if (r.inferred) {
    msg =
      `deployment mode is not declared; inferring "${r.mode}" ` +
      `(set CATALYST_DEPLOYMENT_MODE, or catalyst.deployment.mode in Layer-1/Layer-2 config, to make it explicit)`;
  } else if (!r.recognized) {
    msg =
      `deployment mode "${printableRaw(r.raw)}" is not one of [${DEPLOYMENT_MODES.join(", ")}] — ` +
      `treating this node as "${r.mode}" (safest); catalyst doctor will FAIL until the value is corrected`;
  }
  if (msg && !_warnedDeploymentMode.has(msg)) {
    _warnedDeploymentMode.add(msg);
    console.warn(`[deployment-mode] ${msg}`);
  }
  return r.mode;
}
