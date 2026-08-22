// doctor-event-log-window.mjs — CTL-1216.
//
// The window resolver `catalyst doctor`'s sdk-bg-fallback scan uses, extracted
// from doctor.mjs.
//
// ── WHY IT IS NOT INLINE IN doctor.mjs ──────────────────────────────────────
// event-log-read-guard.test.mjs (CTL-1529) propagates event-log "taint" through
// a file by NAME and dataflow: an `eventsDir`-shaped local makes every
// downstream `readFileSync(p, ...)` in the same file look like a whole-file read
// of the event log. doctor.mjs has ~19 such reads — of launchd plists, .zshenv,
// env files — none of which touch the event log. Inlining this helper there
// turned all 19 into guard violations.
//
// The right response was NOT to rename the local until the name-based heuristic
// stopped matching: that guard's own header says the exemption must be visible
// at the code and "no one can self-exempt". Renaming to dodge it is precisely
// that. Moving the event-log dataflow into a file that genuinely deals with
// event-log paths — and reads nothing at all — keeps the taint where it belongs
// and leaves doctor.mjs at zero, which is what it was before this ticket.
//
// Zero-npm-import for the same reason as lib/event-log-paths.mjs: bare-Node
// `catalyst doctor` must load it with no node_modules.

import { join, basename } from "node:path";
import {
  resolveEventLogPathsForWindow,
  eventLogBasenameFor,
  resolveRotationScheme,
  parseEventLogBasename,
} from "../lib/event-log-paths.mjs";

// eventLogPathsForWindow — every log file overlapping [sinceMs, nowMs], oldest
// -first. CTL-1216: this replaces monthlyLogPath + a hand-built "current, plus
// the previous month if the cutoff crossed a boundary" pair (Codex P2: a
// fallback written just before the boundary is still inside 24h but lives in
// the previous file). That pair covers the window only while a file is about a
// month long; the resolver enumerates the directory instead, so it stays correct
// under weekly rotation and across a scheme change, where a YYYY-MM.jsonl and a
// YYYY-Www.jsonl sit side by side and neither computed name finds the other.
export function eventLogPathsForWindow(eventsDir, nowMs, windowMs) {
  // ⚠️ `resolve()` is deliberately NOT used on any value in this function.
  // event-log-read-guard.test.mjs propagates event-log taint through helpers,
  // and piping a tainted path through `resolve` marks `resolve` ITSELF a tainted
  // producer file-wide — which then flagged `const plist = resolve(homedir(), …)`
  // in defaultDaemonPath as a whole-file event-log read. Every caller passes an
  // absolute events dir (and the leaf returns absolute paths), so `join` is
  // equivalent here and keeps the taint local.
  const dir = eventsDir;
  const sinceMs = nowMs - windowMs;
  const scheme = resolveRotationScheme({ env: process.env });

  // The COMPUTED floor: the file holding the cutoff and the file holding now.
  // This is exactly the pair the pre-CTL-1216 code built, and it is kept as a
  // floor rather than replaced, because enumeration answers "" for a directory
  // it cannot read — and a check whose job is to DETECT something must never
  // conclude "clean" from an empty input set. `[].every(p)` is `true`, and a
  // zero-path loop printing an all-clear is a false-clean this repo has shipped
  // before. It also keeps the resolver honest under an injected scan seam, where
  // there is no real directory to enumerate at all.
  const floor = [
    join(dir, eventLogBasenameFor(new Date(sinceMs), scheme)),
    join(dir, eventLogBasenameFor(new Date(nowMs), scheme)),
  ];

  // The ENUMERATED set: everything actually on disk that overlaps the window.
  // This is the generalization — a weekly window can span more than two files,
  // and across a scheme change a YYYY-MM.jsonl sits beside a YYYY-Www.jsonl
  // where neither computed name finds the other.
  const found = resolveEventLogPathsForWindow({
    eventsDir: dir,
    sinceMs,
    nowMs,
    env: process.env,
  });

  // Union, oldest-first. Sorting by the interval each NAME encodes, never
  // lexically: "2026-08.jsonl" and "2026-W34.jsonl" do not sort chronologically
  // as strings.
  const seen = new Map();
  for (const pth of [...floor, ...found]) {
    if (seen.has(pth)) continue;
    const iv = parseEventLogBasename(basename(pth));
    seen.set(pth, iv ? iv.startMs : 0);
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([pth]) => pth);
}
