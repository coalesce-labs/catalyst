// claude-ids.mjs — mjs equivalent of lib/claude-ids.sh.
// Translate full UUID `.sessionId` ↔ 8-char short job ID, and detect whether
// a given ID belongs to the controlling claude session.
//
// CTL-649 comment 9a3d0645: `claude stop` rejects full UUIDs with rc=1
// silently. Anything that derives its target from `claude agents --json`
// MUST truncate via `shortIdFromSessionId` before feeding it to
// `claude stop` / `kill` / `attach` / `logs` / `respawn` / `rm`.

const HEX8 = /^[0-9a-f]{8}$/;
const HEX8_PREFIX = /^([0-9a-f]{8})-/;

/**
 * Convert a full UUID (or already-short ID) into the 8-char hex short ID.
 * Throws on empty/malformed input.
 */
export function shortIdFromSessionId(input) {
  if (input == null || input === "") {
    throw new Error("shortIdFromSessionId: empty input");
  }
  const s = String(input);
  if (HEX8.test(s)) return s;
  const m = s.match(HEX8_PREFIX);
  if (m) return m[1];
  throw new Error(`shortIdFromSessionId: malformed input '${s}'`);
}

/**
 * Return true when `candidate` matches process.env.CLAUDE_CODE_SESSION_ID
 * (compared on 8-char prefix so short and full forms both work). Returns
 * false when CLAUDE_CODE_SESSION_ID is unset.
 *
 * Mandatory guard for prune subcommands: skipping self prevents an operator
 * from killing their own controlling session mid-cleanup.
 */
export function isSelfSession(candidate, env = process.env) {
  const self = env.CLAUDE_CODE_SESSION_ID;
  if (!self || !candidate) return false;
  let selfShort, candShort;
  try {
    selfShort = shortIdFromSessionId(self);
    candShort = shortIdFromSessionId(candidate);
  } catch {
    return false;
  }
  return selfShort === candShort;
}
