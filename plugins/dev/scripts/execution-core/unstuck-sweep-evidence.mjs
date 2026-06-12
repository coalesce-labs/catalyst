// unstuck-sweep-evidence.mjs — CTL-1064 Phase 6 deep-dive evidence collector.
//
// captureDeepDiveEvidence assembles the manual rescue chain evidence envelope
// (signal files → noise-filtered porcelain → PR REST state → event-log remediate
// history) before an escalation comment is authored. All IO injected.
// Mirrors diagnostician.mjs:83 pattern.

import { REBASE_NOISE_PATHS } from "./dirty-tree-classifier.mjs";
import { cleanPorcelain } from "./worktree-safety.mjs";

// captureDeepDiveEvidence — assembles evidence for one stalled ticket/phase.
// Returns { subject, signalJson, porcelainLines, prState, remediateHistory, capturedAt }.
// Degrades gracefully: prState/remediateHistory fall back to null/[] on seam failure.
// All IO injected — pure given the seams.
//
// opts shape:
//   readSignal(ticket, phase)         → object|null
//   runGitPorcelain(worktreePath)     → string|null
//   isNoisePath(path)                 → bool  (use REBASE_NOISE_PATHS to build one)
//   queryPR(ticket)                   → string|null ('MERGED'|'OPEN'|'CLOSED'|null)
//   listRemediateEvents(ticket)       → Array<{round, verifyFindings, remediateChanges, reVerifyResult}>
export function captureDeepDiveEvidence(subject, {
  readSignal = () => null,
  runGitPorcelain = () => null,
  isNoisePath = (p) => REBASE_NOISE_PATHS.some((n) => p === n || p.startsWith(n + "/")),
  queryPR = () => null,
  listRemediateEvents = () => [],
} = {}) {
  const [ticket, phase] = String(subject).split("/");

  let signalJson = null;
  try { signalJson = readSignal(ticket, phase); } catch { signalJson = null; }

  let porcelainLines = [];
  try {
    const raw = runGitPorcelain(signalJson?.worktreePath ?? null);
    if (raw) {
      const allLines = raw.split("\n").filter((l) => l.trim().length > 0);
      porcelainLines = cleanPorcelain(allLines.join("\n"), REBASE_NOISE_PATHS)
        .filter((l) => {
          // Extra filter: also remove deleted node_modules via isNoisePath
          const path = l.slice(3).trim().replace(/^"|"$/g, "");
          return !isNoisePath(path);
        });
    }
  } catch { porcelainLines = []; }

  let prState = null;
  try { prState = queryPR(ticket); } catch { prState = null; }

  let remediateHistory = [];
  try { remediateHistory = listRemediateEvents(ticket) ?? []; } catch { remediateHistory = []; }

  return {
    subject,
    ticket,
    phase,
    signalJson,
    porcelainLines,
    prState,
    remediateHistory,
    capturedAt: new Date().toISOString(),
  };
}
