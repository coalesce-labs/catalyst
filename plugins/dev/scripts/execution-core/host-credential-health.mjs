// host-credential-health.mjs — CTL-2045 §3, the `catalyst doctor` half.
//
// "Given an already-provisioned host whose write credential is later replaced by an admin
//  bearer, when catalyst doctor runs, then the check does NOT pass, and names the
//  credential class it found."
//
// §1's gate lives at PROVISIONING and can only see an install. This is the standing
// answer for a host that DRIFTS into the bad state afterwards — a re-mint, a restore from
// a backup, a hand-edit, or an installer that predates the gate. mini-2 spent four hours
// in exactly that state on 2026-08-18 with every existing check green: doctor passed, the
// daemons ran, the heartbeat was fresh, and the local write ledger showed ZERO refusals,
// because nothing ever got far enough to be refused locally.
//
// ⛔ ADVISORY — never FAIL. doctor's FAIL count gates worker activation, and a host with
// the wrong write credential is ALREADY unable to claim; failing it here would convert a
// visible degradation into a second, differently-shaped outage while fixing nothing. Same
// posture and same reason as checkLinearWriteBudget and checkRegistryTeamIdentity.
//
// ⚠️ THREE-VALUED, AND IT CAN NEVER PASS ON ABSENCE. A missing or unreadable
// cloud-sync.env, or a file with no token line, is reported as INFO/WARN — never PASS.
// "I could not look" and "I looked and it is fine" are different answers, and collapsing
// them is how a check that cannot fail gets shipped.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { classifyHostWriteCredential } from "../lib/host-write-credential.mjs";
// ⛔ Codex P2 on #3706. The token's env-var NAME is CONFIGURABLE, and the installer
// resolves it through env → Layer-2 `catalyst.cloud.tokenEnv` → default before writing
// the file. Hardcoding the default here meant that on a host using a custom name this
// check read a variable the file does not set and reported "the writer would receive no
// token" — grading the wrong variable instead of the credential actually in use, and
// reporting a WARN that says the opposite of what is wrong.
//
// ⚠️ It is also precisely the "every test injects, so the DEFAULT is untested" trap: the
// suite covered `tokenVar` injection and therefore never exercised the default path.
//
// resolveCloudTokenName is the canonical resolver (config.mjs's resolveNodeCloudTokenEnv
// is a thin delegate onto it) and lives in the ZERO-IMPORT secret-contract leaf, so
// importing it here keeps this module loadable under doctor's bare-Node runtime.
import { resolveCloudTokenName } from "../lib/secret-contract.mjs";
import { STATUS, mkCheck } from "./doctor-status.mjs";

const CHECK = "host-write-credential-class";

/**
 * extractExportedValue(text, varName) -> string | null
 *
 * cloud-sync.env is a shell file of `export NAME=value` lines (every line MUST be
 * exported — launch.sh sources it then execs bun, so a bare assignment would leave the
 * writer tokenless). Parsed rather than sourced: doctor must never execute a file it is
 * inspecting, and a `$(…)` in a hand-edited env file would run as this process.
 *
 * ⚠️ Takes the LAST match, not the first. A file that was appended to rather than
 * replaced carries several assignments and the shell would honour the last one — so the
 * last is the credential the writer actually receives, and grading the first would grade
 * a value nothing uses.
 */
export function extractExportedValue(text, varName) {
  if (typeof text !== "string" || !varName) return null;
  let found = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || m[1] !== varName) continue;
    let v = m[2].trim();
    // Strip one layer of surrounding quotes if present; the writer's own output is
    // unquoted, but a hand-edited file may not be.
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    found = v;
  }
  return found;
}

export function checkHostWriteCredentialClass(deps = {}) {
  const {
    envPath = process.env.CATALYST_CLOUD_SYNC_ENV ||
      resolve(homedir(), ".config", "catalyst", "cloud-sync.env"),
    exists = existsSync,
    readFile = (p) => readFileSync(p, "utf8"),
    // NAME-only resolution — never reads the secret VALUE, so it is safe to render.
    tokenVar = resolveCloudTokenName(process.env).envVar,
    classify = classifyHostWriteCredential,
  } = deps;

  if (!exists(envPath)) {
    // The normal state for a host with no cloud replica provisioned. Not health, not a
    // problem — and explicitly NOT a pass.
    return mkCheck(
      CHECK,
      STATUS.INFO,
      `no cloud-sync.env at ${envPath} — this host has no provisioned cloud write credential`
    );
  }

  let text;
  try {
    text = readFile(envPath);
  } catch (err) {
    return mkCheck(
      CHECK,
      STATUS.WARN,
      `cloud-sync.env present but UNREADABLE at ${envPath} (${err?.message ?? err}) — ` +
        `this host's write-credential class could NOT be determined (CTL-2045)`
    );
  }

  const token = extractExportedValue(text, tokenVar);
  if (token === null) {
    return mkCheck(
      CHECK,
      STATUS.WARN,
      `cloud-sync.env carries no 'export ${tokenVar}=' line — the writer resolves that name ` +
        `and would receive no token, so this host cannot write to the cloud at all (CTL-2045)`
    );
  }

  const { verdict, shape, detail } = classify(token);
  if (verdict === "org-key") {
    return mkCheck(
      CHECK,
      STATUS.PASS,
      `host write credential is a per-host organization key (${shape})`
    );
  }

  // ⛔ `shape`, never `token`. The classifier pre-redacts precisely so that no caller —
  // including a doctor report an operator will paste into a thread — can leak the secret.
  return mkCheck(
    CHECK,
    STATUS.WARN,
    `WRONG CREDENTIAL CLASS — got ${shape} (${verdict}): ${detail}. ` +
      `Every cross-host claim write from this host is refused, so it will claim no ticket ` +
      `on any phase while looking healthy in every other check (CTL-2045).`
  );
}
