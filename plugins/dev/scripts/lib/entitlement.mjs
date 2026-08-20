// entitlement.mjs — CTL-1785 (W13, host half of CTC-411): the entitlement seam.
//
// WHY THIS FILE EXISTS. Today fleet MEMBERSHIP conflates two facts that must be
// split:
//   - EXISTENCE   — "is this node in the fleet, observable/monitorable?" — is
//     local, self-declared, needs no network, and must keep working during a
//     cloud outage.
//   - ENTITLEMENT — "may this node take work?" — is a lease from an external
//     authority, required to claim, and self-expiring (it lapses on its own TTL
//     with no peer-liveness query involved).
// `getClusterHosts()` reads cluster.json.roster and every dispatch/recovery gate
// hashes HRW ownership over that list, so being LISTED implies being ENTITLED —
// the exact CTL-1760 blind spot (mini-2 stayed a work-owner "by declaration" for
// 33 days after it went silent). This module is the host-side entitlement seam:
// an injectable EntitlementProvider whose default (local) provider reproduces
// today's behavior (entitled iff self ∈ roster), plus a tri-state
// off/shadow/enforce rollout flag. The real lease STORE is W12 (CTL-1786, the
// Durable Object) and is unmerged; this leaf ships against an injectable provider
// boundary + a local fallback so CTL-1785 is shippable and CI-green independently.
//
// ZERO-IMPORT LEAF (node:fs / node:os / node:path only) — mirrors
// lib/deployment-mode.mjs's rationale verbatim: doctor.mjs runs under bare Node
// and must import this without pulling execution-core/config.mjs's heavier module
// graph (which reaches bun:sqlite via linear-query.mjs, rejected by the Node ESM
// loader at load time). execution-core/config.mjs re-exports these names with a
// one-line import; orch-monitor may import this file directly.
//
// LADDER DUPLICATION IS DELIBERATE. The mode-ladder mechanics below
// (resolveLayer{1,2}Path, the surrogate-escape guard, classifyCandidate) are a
// near-verbatim mirror of lib/deployment-mode.mjs. They are NOT shared via an
// import because both files are zero-import leaves and neither may import the
// other (deployment-mode.mjs exports no ladder helpers, and adding an export
// there to serve this file would couple two independent leaves). The codebase
// already keeps such mirrors honest by convention (secret-contract.mjs's bash/JS
// pair, deployment-mode's own surrogate scanner kept "in lockstep" with
// secret-contract's) rather than by a shared dependency. Keep this ladder
// byte-behaviorally identical to deployment-mode.mjs's.
//
// NAMING: this is the ENTITLEMENT mode, read as `catalyst.entitlement.mode` /
// CATALYST_ENTITLEMENT — distinct from deployment mode, dispatchMode, node.class.
//
// FAIL DIRECTION: ENTITLED. Unlike lane-claim.mjs (a refusal guard whose fail
// direction is ALLOW so it can't wedge the pipeline), this is a PERMIT whose
// absence must not silently strand a healthy fleet before the authority is
// wired. Any inability to decide (malformed input, no authority) resolves to
// ENTITLED — i.e. today's behavior — never UNENTITLED.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ENTITLEMENT_MODES — the closed enum. Frozen: callers must never mutate in
// place. off = today's behavior (byte-identical), shadow = observe would-shed but
// change nothing, enforce = actually shed unentitled hosts + revoke their leases.
export const ENTITLEMENT_MODES = Object.freeze(["off", "shadow", "enforce"]);

// The safest degradation target for every soft-failure case (unset, non-string,
// or unrecognized string). off means "act exactly as every host does today" —
// zero-config, zero-behavior-change (mirrors DEPLOYMENT_MODE_DEFAULT's contract).
const ENTITLEMENT_MODE_DEFAULT = "off";

// Local-provider TTL. Deliberately a long window — the local provider never
// actually expires anything (self ∈ its own roster is stable), but a provider
// must expose a ttlMs for the ordering constraint (Phase 4). 15 min mirrors the
// plan's ENTITLEMENT_TTL default (> HEARTBEAT_GRACE_MS 10 min, > CLAIM_STALE 5 min).
const LOCAL_ENTITLEMENT_TTL_MS = 15 * 60 * 1000;

// verdict shape mirrors lane-claim.mjs (CTL-2068): a frozen VERDICT enum plus a
// named REASON so a log line, an event, and a test all agree, and an operator
// can tell a judged verdict from an unanswerable one.
export const VERDICT = Object.freeze({
  ENTITLED: "entitled",
  UNENTITLED: "unentitled",
  INCONCLUSIVE: "inconclusive",
});

export const REASON = Object.freeze({
  PRESENT_IN_LOCAL_ROSTER: "present-in-local-roster",
  ABSENT_FROM_LOCAL_ROSTER: "absent-from-local-roster",
  LEASE_HELD: "lease-held-and-fresh",
  LEASE_LAPSED: "lease-lapsed",
  NO_AUTHORITY: "no-lease-authority-configured",
  BAD_INPUT: "malformed-input",
  AUTHORITY_UNREACHABLE: "lease-authority-unreachable",
});

// --- mode ladder (near-verbatim mirror of lib/deployment-mode.mjs) ---

// resolveLayer2Path — explicit layer2ConfigPath wins; else
// env.CATALYST_LAYER2_CONFIG_FILE; else ~/.config/catalyst/config.json. Reads the
// injected env (not process.env) so resolution stays pure/testable; prefers
// env.HOME over homedir() so an injected { env: { HOME } } fixture is honored.
function resolveLayer2Path(env, layer2ConfigPath) {
  if (typeof layer2ConfigPath === "string" && layer2ConfigPath.length > 0) {
    return layer2ConfigPath;
  }
  const override = env?.CATALYST_LAYER2_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  const home = typeof env?.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
  return resolve(home, ".config", "catalyst", "config.json");
}

// resolveLayer1Path — explicit layer1ConfigPath wins; else env.CATALYST_CONFIG_FILE;
// else cwd/.catalyst/config.json.
function resolveLayer1Path(env, layer1ConfigPath) {
  if (typeof layer1ConfigPath === "string" && layer1ConfigPath.length > 0) {
    return layer1ConfigPath;
  }
  const override = env?.CATALYST_CONFIG_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  return resolve(process.cwd(), ".catalyst", "config.json");
}

// hasLiveLoneHighSurrogateEscape / toWellFormedString — kept in lockstep with
// lib/deployment-mode.mjs's identical pair (jq's actual acceptance: a lone LOW
// surrogate escape is substituted U+FFFD; only a lone HIGH escape rejects the
// whole document; an even-length backslash run before uXXXX is literal text).
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

// readEntitlementModeField — pull catalyst.entitlement.mode out of a config file
// EXACTLY as written. Returns undefined when the file is absent/malformed/
// unreadable OR the key is absent — both count as "nothing here, try the next
// layer". Never throws.
function readEntitlementModeField(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    if (hasLiveLoneHighSurrogateEscape(text)) return undefined;
    const mode = JSON.parse(text)?.catalyst?.entitlement?.mode;
    return typeof mode === "string" ? toWellFormedString(mode) : mode;
  } catch {
    return undefined;
  }
}

// classifyCandidate — apply the validity ladder to ONE layer's raw candidate.
// Mirrors deployment-mode.mjs exactly: undefined/null ⇒ fall through;
// present-but-non-string ⇒ explicit misconfiguration ⇒ default, recognized:false;
// string ⇒ ASCII trim + lowercase (deliberately narrower than String.trim() for
// bash parity), empty ⇒ fall through; member ⇒ recognized:true; non-member ⇒
// default, recognized:false.
function classifyCandidate(raw, source) {
  if (raw === undefined || raw === null) return { fallthrough: true };
  if (typeof raw !== "string") {
    return {
      result: { mode: ENTITLEMENT_MODE_DEFAULT, source, inferred: false, recognized: false, raw },
    };
  }
  const normalized = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "").toLowerCase();
  if (normalized.length === 0) return { fallthrough: true };
  if (ENTITLEMENT_MODES.includes(normalized)) {
    return { result: { mode: normalized, source, inferred: false, recognized: true, raw } };
  }
  return {
    result: { mode: ENTITLEMENT_MODE_DEFAULT, source, inferred: false, recognized: false, raw },
  };
}

// resolveEntitlementMode — pure, no-logging resolver. Never throws. Precedence:
// env CATALYST_ENTITLEMENT → Layer-2 catalyst.entitlement.mode → Layer-1
// catalyst.entitlement.mode → constant default "off". Returns
// { mode, source, inferred, recognized, raw }. Accepts injectable
// { env, layer1ConfigPath, layer2ConfigPath } so tests redirect every input.
export function resolveEntitlementMode({ env = process.env, layer1ConfigPath, layer2ConfigPath } = {}) {
  const envCandidate = classifyCandidate(env?.CATALYST_ENTITLEMENT, "env");
  if (envCandidate.result) return envCandidate.result;

  const l2Path = resolveLayer2Path(env, layer2ConfigPath);
  const l2Candidate = classifyCandidate(readEntitlementModeField(l2Path), "layer2");
  if (l2Candidate.result) return l2Candidate.result;

  const l1Path = resolveLayer1Path(env, layer1ConfigPath);
  const l1Candidate = classifyCandidate(readEntitlementModeField(l1Path), "layer1");
  if (l1Candidate.result) return l1Candidate.result;

  return { mode: ENTITLEMENT_MODE_DEFAULT, source: "default", inferred: true, recognized: true, raw: null };
}

// printableRaw — render an offending raw value for a WARN without ever throwing
// (mirrors deployment-mode.mjs: a JSON value like {"toString": null} would throw
// on template coercion, breaking getEntitlementMode's never-throws contract on
// exactly the degraded path it exists to report).
function printableRaw(raw) {
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return "[unprintable value]";
  }
}

// getEntitlementMode — the convenience accessor. Resolves FRESH per call (file
// edits picked up live); only the WARN-dedup Set is cached (once per process),
// mirroring getDeploymentMode. Never throws.
const _warnedEntitlementMode = new Set();
export function getEntitlementMode(opts = {}) {
  const r = resolveEntitlementMode(opts);
  let msg = null;
  if (!r.recognized) {
    msg =
      `entitlement mode "${printableRaw(r.raw)}" is not one of [${ENTITLEMENT_MODES.join(", ")}] — ` +
      `treating this node as "${r.mode}" (safest, byte-identical to today)`;
  }
  if (msg && !_warnedEntitlementMode.has(msg)) {
    _warnedEntitlementMode.add(msg);
    console.warn(`[entitlement] ${msg}`);
  }
  return r.mode;
}

// makeLocalEntitlementProvider — the default provider that reproduces today's
// behavior: ENTITLED iff self ∈ roster (the same predicate getClusterHosts-based
// HRW ownership implicitly used). Verdict shape mirrors lane-claim.mjs.
//
// check() is TOTAL and never throws; the FAIL DIRECTION IS ENTITLED, so any
// inability to decide (malformed input, missing roster) preserves today's
// behavior — this is a permit whose absence must not strand a healthy fleet
// before W12's authority is wired.
export function makeLocalEntitlementProvider({ ttlMs = LOCAL_ENTITLEMENT_TTL_MS } = {}) {
  return {
    ttlMs,
    check({ host, roster } = {}) {
      if (typeof host !== "string" || !host || !Array.isArray(roster)) {
        return { verdict: VERDICT.ENTITLED, reason: REASON.BAD_INPUT }; // inconclusive → entitled
      }
      return roster.includes(host)
        ? { verdict: VERDICT.ENTITLED, reason: REASON.PRESENT_IN_LOCAL_ROSTER }
        : { verdict: VERDICT.UNENTITLED, reason: REASON.ABSENT_FROM_LOCAL_ROSTER };
    },
  };
}
