// wait-state-classifier.mjs — CTL-650 Phase 1. The pure, I/O-free core of the
// push-based session wait-state watcher: a faithful port of the prototype's
// decision tree (~/bin/claude-bg-waiting.sh:171-202) and its last_sentences
// text extractor (:53-79).
//
// The classifier takes a flattened snapshot of one session's most recent
// assistant turn (derived elsewhere by tailing the transcript) plus the
// authoritative live `status` from `claude agents --json`, and returns the
// session's wait state. Keeping this a pure function makes the risky branching
// fully unit-testable without touching the filesystem or shelling out.

// The three states that mean "a human (or a permission grant) is the only thing
// that will move this session forward." Exported so the watcher (Phase 3) and
// the CLI consumer (Phase 5) classify transitions against the same set.
export const WAITING_STATES = new Set(["WAITING_USER", "WAITING_TOOL_OK", "WAITING_PERM"]);

// Tools whose pending call is a deliberate, expected ask of the user rather than
// a permission prompt — they are the agent's own UI for blocking on input.
const TOOL_OK = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);

/**
 * classifyWaitState — map one session's last-assistant snapshot to a wait state.
 *
 * @param {object} input
 * @param {?string} input.status               live `claude agents` status; "busy" is authoritative
 * @param {?string} input.lastBlockType        type of the last content block ("text"/"tool_use"/…)
 * @param {?string} input.lastTool             name of the last tool_use block, if any
 * @param {?string} input.stopReason           message.stop_reason of the last assistant turn
 * @param {?string} input.lastText             text of the last content block (for WAITING_USER)
 * @param {number}  [input.postUserOrResultCount=0] user/tool_result lines after the last assistant
 * @param {boolean} [input.hasTranscript=true] false when no JSONL exists on disk
 * @returns {{ state: string, detail?: string, waitingText?: string }}
 */
export function classifyWaitState({
  status,
  lastBlockType,
  lastTool,
  stopReason,
  lastText,
  postUserOrResultCount = 0,
  hasTranscript = true,
} = {}) {
  if (!hasTranscript) return { state: "NO_TRANSCRIPT", detail: "" };

  // The daemon's status is authoritative for "is it executing right now." A busy
  // session is actively working and is NEVER waiting on the user, no matter what
  // the last turn's stop_reason says — background agents post a text summary then
  // keep going, which reads as end_turn but isn't a wait (prototype :164-170).
  const busy = status === "busy";
  if (busy) {
    return lastBlockType === "tool_use"
      ? { state: "MID_TURN", detail: `tool=${lastTool}` }
      : { state: "ACTIVE", detail: "working" };
  }

  // Not busy + last action was a tool call with no result yet → blocked. An
  // AskUserQuestion/Plan-mode tool is an expected user-action ask; anything else
  // is a permission prompt.
  if (lastBlockType === "tool_use" && postUserOrResultCount === 0) {
    return TOOL_OK.has(lastTool)
      ? { state: "WAITING_TOOL_OK", detail: `tool=${lastTool}` }
      : { state: "WAITING_PERM", detail: `tool=${lastTool}` };
  }

  // Not busy + turn ended cleanly → parked waiting for the next prompt.
  if (stopReason === "end_turn") {
    return { state: "WAITING_USER", waitingText: extractWaitingText(lastText), detail: "" };
  }

  // Not busy, tool call already resolved → paused between sub-steps.
  if (lastBlockType === "tool_use") {
    return { state: "MID_TURN", detail: `tool=${lastTool}` };
  }

  return { state: "UNKNOWN", detail: `stop=${stopReason} block=${lastBlockType}` };
}

/** isWaitingState — true iff `state` is one of the three waiting states. */
export function isWaitingState(state) {
  return WAITING_STATES.has(state);
}

/**
 * extractWaitingText — the agent's actual question or closing statement lands at
 * the END of the last assistant text, not the start, so we keep the tail. Port
 * of `last_sentences` (~/bin/claude-bg-waiting.sh:53-79): the trailing one-to-two
 * complete sentences plus any dangling unpunctuated fragment, whitespace-collapsed
 * and length-capped from the end.
 *
 * @param {?string} text         the raw last-block text
 * @param {number}  [maxLen=200] cap on the returned length
 * @returns {string} the trimmed trailing text, "" for empty/whitespace input
 */
export function extractWaitingText(text, maxLen = 200) {
  if (text == null) return "";
  // Trim trailing whitespace (the bash version trims the tail before matching).
  const trimmed = String(text).replace(/\s+$/, "");
  if (trimmed === "") return "";

  // Last 2 complete sentences (chunks ending in . ! or ?)…
  const sentences = trimmed.match(/[^.!?]+[.!?]+/g) ?? [];
  const tail2 = sentences.slice(-2).join(" ");
  // …plus any dangling fragment after the final terminator (an unpunctuated ask).
  // The `s` flag lets `.*` span newlines so the greedy match reaches the LAST
  // terminator, mirroring `sed -E 's/.*[.!?]//'`.
  const frag = trimmed.replace(/.*[.!?]/s, "");

  let out = `${tail2} ${frag}`.replace(/\s+/g, " ").trim();
  // No punctuation anywhere → fall back to the whole (collapsed) text.
  if (out === "") out = trimmed.replace(/\s+/g, " ").trim();

  // Cap length, keeping the END of the string (prepend an ellipsis when cut).
  if (out.length > maxLen) {
    out = `…${out.slice(-(maxLen - 1))}`;
  }
  return out;
}
