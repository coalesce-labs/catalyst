// journey.mjs — GET /api/journey/:ticket data assembly (CTL-1100 Phase 5).
// bun:sqlite-free throughout (ticket-runs uses the sqlite3 binary, not bun:sqlite).
// Plain static import safe in server.ts.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── dependency imports ───────────────────────────────────────────────────────

import { scanEventsChunked } from "../../execution-core/event-tail.mjs";
import { deriveAdvancement, readPhaseSignals } from "../../execution-core/scheduler.mjs";
import { readVerifyVerdict } from "../../execution-core/work-done-probes.mjs";
import { countRemediateCycles } from "../../execution-core/event-scan.mjs";
import { assembleTicketRuns } from "./ticket-runs.mjs";
import { PHASE_ORDER } from "./board-data.mjs";

// ── defaults ─────────────────────────────────────────────────────────────────

function defaultOrchDir() {
  return join(homedir(), "catalyst", "execution-core");
}

function defaultWorkersDir() {
  return join(defaultOrchDir(), "workers");
}

function defaultEventLogPath() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(homedir(), "catalyst", "events", `${ym}.jsonl`);
}

// ── scanHops ─────────────────────────────────────────────────────────────────
// Scan the event log for `phase.*.<ticket>` events. Uses exact suffix
// ".ticket" so CTL-9001 never matches CTL-90010 (leading-dot suffix fix).
// Returns an array of raw hop objects (may have duplicates).
export function scanHops(ticket, { eventLogPath = defaultEventLogPath() } = {}) {
  const suffix = "." + ticket;
  const hops = [];
  try {
    scanEventsChunked({
      path: eventLogPath,
      onEvent: (ev) => {
        const name = ev?.attributes?.["event.name"];
        if (typeof name !== "string") return;
        if (!name.startsWith("phase.")) return;
        if (!name.endsWith(suffix)) return;
        // Parse: "phase.<phase>.<eventType>.<ticket>"
        // Strip "phase." prefix and ".<ticket>" suffix, split on first ".".
        const inner = name.slice("phase.".length, name.length - suffix.length);
        const dotIdx = inner.indexOf(".");
        if (dotIdx < 0) return;
        const phase = inner.slice(0, dotIdx);
        const eventType = inner.slice(dotIdx + 1);
        const payload = ev?.body?.payload ?? {};
        hops.push({
          phase,
          eventType,
          ts: ev?.ts ?? "",
          host: ev?.resource?.["host.name"] ?? ev?.resource?.["service.instance.id"] ?? "",
          bg_job_id: payload.bg_job_id ?? undefined,
          reason: payload.reason ?? undefined,
          targetPhase: payload.target_phase ?? undefined,
          blockers: Array.isArray(payload.blockers) ? payload.blockers : undefined,
        });
      },
    });
  } catch { /* missing log or parse error — degrade to [] */ }
  return hops;
}

// ── dedupeHops ───────────────────────────────────────────────────────────────
// Dedup by (phase, eventType, bg_job_id|generation|ts). Keep earliest.
// Sort ascending by ts (unparseable sorts last).
export function dedupeHops(hops) {
  const seen = new Map();
  for (const h of hops) {
    const key = `${h.phase}|${h.eventType}|${h.bg_job_id ?? h.generation ?? h.ts}`;
    const existing = seen.get(key);
    if (!existing || Date.parse(h.ts) < Date.parse(existing.ts)) {
      seen.set(key, h);
    }
  }
  return [...seen.values()].sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return ta - tb;
  });
}

// ── readVerifyVerdictDetail ───────────────────────────────────────────────────
// Reads verify.json for raw drivers plus calls readVerifyVerdict for
// the canonical pass/fail/null classification.
export function readVerifyVerdictDetail(ticket, { orchDir = defaultOrchDir() } = {}) {
  const empty = { verdict: null, regressionRisk: null, highFindings: 0, reason: null };
  if (!ticket || !orchDir) return empty;
  try {
    const path = join(orchDir, "workers", ticket, "verify.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const regressionRisk = typeof raw.regression_risk === "number" ? raw.regression_risk : null;
    const highFindings = Array.isArray(raw.findings)
      ? raw.findings.filter((f) => f?.severity === "high").length
      : 0;
    const verdict = readVerifyVerdict({ ticket, orchDir });
    let reason = null;
    if (verdict === "fail") {
      if (regressionRisk != null && regressionRisk >= 5) reason = "regression_risk";
      else if (highFindings > 0) reason = "high_severity_finding";
    }
    return { verdict, regressionRisk, highFindings, reason };
  } catch {
    return empty;
  }
}

// ── buildGateChecklist ────────────────────────────────────────────────────────
// Reads signals, verdict, cycles. Calls deriveAdvancement to compute nextPhase.
// Returns { nextPhase, checklist[], remediateCycles }.
export function buildGateChecklist(ticket, { orchDir = defaultOrchDir(), eventLogPath } = {}) {
  const empty = { nextPhase: null, checklist: [], remediateCycles: 0 };
  if (!ticket || !orchDir) return empty;
  try {
    const signals = readPhaseSignals(orchDir, ticket);
    const { verdict } = readVerifyVerdictDetail(ticket, { orchDir });
    let remediateCycles = 0;
    try {
      remediateCycles = countRemediateCycles({
        ticket,
        path: eventLogPath ?? defaultEventLogPath(),
      });
    } catch { /* no event log or error — stay at 0 */ }

    const nextPhase = deriveAdvancement(signals, {
      verifyVerdict: verdict ?? undefined,
      remediateCycleCount: remediateCycles,
    });

    const checklist = PHASE_ORDER.map((phase) => {
      const signalStatus = signals[phase] ?? null;
      const satisfied = signalStatus === "done" ||
        (phase === "monitor-deploy" && signalStatus === "skipped");
      return { phase, signalStatus, satisfied };
    });

    return { nextPhase, checklist, remediateCycles };
  } catch {
    return empty;
  }
}

// ── collectUnblockHints ───────────────────────────────────────────────────────
// Returns operator-note hints from .respond-<phase>.json files and the latest
// phase.advance.held hop's reason/blockers.
export function collectUnblockHints(ticket, { orchDir = defaultOrchDir(), hops = [] } = {}) {
  const hints = [];
  if (!ticket || !orchDir) return hints;
  // Operator respond notes from .respond-<phase>.json files.
  const workerDir = join(orchDir, "workers", ticket);
  try {
    const files = readdirSync(workerDir);
    for (const f of files) {
      if (!f.startsWith(".respond-") || !f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(workerDir, f), "utf8"));
        if (data.response) {
          hints.push({ kind: "operator-note", note: data.response, respondedAt: data.respondedAt });
        }
      } catch { /* malformed respond file — skip */ }
    }
  } catch { /* no worker dir — no hints */ }

  // Latest held event's reason/blockers.
  const held = [...hops].filter((h) => h.phase === "advance" && h.eventType === "held");
  const latest = held.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  if (latest && (latest.reason || latest.blockers)) {
    hints.push({ kind: "held-reason", reason: latest.reason, blockers: latest.blockers });
  }

  return hints;
}

// ── assembleJourney ──────────────────────────────────────────────────────────
// Top-level assembler. Returns the full journey shape. Never throws.
export async function assembleJourney(ticket, {
  workersDir = defaultWorkersDir(),
  orchDir = defaultOrchDir(),
  eventLogPath = defaultEventLogPath(),
  dbPath,
} = {}) {
  const empty = {
    ticket,
    hops: [],
    gates: { checklist: [], nextPhase: null },
    verifyVerdict: { verdict: null, regressionRisk: null, highFindings: 0, reason: null },
    remediateCycles: 0,
    unblockHints: [],
    hosts: [],
  };
  try {
    const [spine, verdictDetail] = await Promise.all([
      (async () => {
        try {
          return await assembleTicketRuns(ticket, { workersDir, dbPath });
        } catch { return { ticket, runs: [] }; }
      })(),
      Promise.resolve(readVerifyVerdictDetail(ticket, { orchDir })),
    ]);

    const rawHops = scanHops(ticket, { eventLogPath });
    const hops = dedupeHops(rawHops);
    const gates = buildGateChecklist(ticket, { orchDir, eventLogPath });
    const unblockHints = collectUnblockHints(ticket, { orchDir, hops });

    // hosts = deduped union of hop hosts + spine run hosts.
    const hostSet = new Set();
    for (const h of hops) if (h.host) hostSet.add(h.host);
    for (const r of (spine.runs ?? [])) if (r.host?.name) hostSet.add(r.host.name);

    return {
      ticket,
      hops,
      gates: { checklist: gates.checklist, nextPhase: gates.nextPhase },
      verifyVerdict: verdictDetail,
      remediateCycles: gates.remediateCycles,
      unblockHints,
      hosts: [...hostSet],
    };
  } catch {
    return empty;
  }
}
