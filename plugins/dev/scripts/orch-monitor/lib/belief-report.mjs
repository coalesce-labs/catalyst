// lib/belief-report.mjs — thin re-export wrapper for beliefs/report.mjs.
// NOTE: DO NOT inline the specifiers below — computed specifiers required
// (VITE-GRAPH GUARD, CTL-883). This file is the single bun:sqlite-touching
// path for the report endpoint; server.ts loads it via a computed specifier.

const REPORT_SPECIFIER = ["../../execution-core/beliefs/report.mjs"].join("");
const READER_SPECIFIER = ["./governance-reader.mjs"].join("");

let _report = null;
async function getReport() {
  if (_report) return _report;
  _report = await import(REPORT_SPECIFIER);
  return _report;
}

let _reader = null;
async function getReader() {
  if (_reader) return _reader;
  _reader = await import(READER_SPECIFIER);
  return _reader;
}

// computeReportJson — one-shot wrapper:
//   1. Opens beliefs.db read-only via openBeliefsDbRO.
//   2. If absent/unreadable returns an empty-but-well-formed report.
//   3. Calls computeReport, closes in finally, returns JSON-serialisable result.
export async function computeReportJson({ dbPath, sinceMs = null, nowMs = null } = {}) {
  // CTL-935 remediate: distinguish "beliefs.db genuinely absent / empty"
  // (degraded:false — a legitimately quiet week) from "report machinery errored"
  // (degraded:true). Without this, the three-layer collapse (computeReport →
  // computeReportJson → endpoint) makes "no disagreements" ambiguous between
  // healthy and broken, which could give false confidence before a gate-flip.
  const emptyReport = (degraded = false, degradedReason = null) => ({
    window: { sinceMs: sinceMs ?? 0, nowMs: nowMs ?? Date.now(), tickCount: 0, rulesShaSet: [], multipleRulesSha: false },
    perRule: [],
    perGuard: [],
    replays: [],
    degraded,
    degradedReason,
  });
  if (!dbPath) return emptyReport();
  try {
    const [mod, reader] = await Promise.all([getReport(), getReader()]);
    const { computeReport } = mod;
    const { openBeliefsDbRO } = reader;
    let db = null;
    try {
      db = await openBeliefsDbRO(dbPath);
      if (!db) return emptyReport(); // DB absent/unreadable — legitimately empty.
      return computeReport(db, { sinceMs, nowMs });
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }
  } catch (err) {
    return emptyReport(true, err?.message ?? String(err));
  }
}
