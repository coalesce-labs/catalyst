// Host-local, zero-network evidence used by board-health. Missing artifacts
// produce no row: absence of evidence is never evidence of absence.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const done = (s) => /^(done|complete|completed)$/.test(String(s ?? "").toLowerCase());
const terminalBad = (s) => /^(stalled|failed)$/.test(String(s ?? "").toLowerCase());

export function buildDoneUnmergedEvidence(orchDir) {
  const out = new Map();
  let tickets;
  try { tickets = readdirSync(join(orchDir, "workers"), { withFileTypes: true }); } catch { return out; }
  for (const entry of tickets) {
    if (!entry.isDirectory()) continue;
    const dir = join(orchDir, "workers", entry.name);
    let names;
    try { names = readdirSync(dir).filter((n) => /^phase-.*\.json$/.test(n)); } catch { continue; }
    const phases = {};
    for (const name of names) {
      try {
        const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
        phases[name.slice(6, -5)] = value;
      } catch { /* malformed signals are ignored */ }
    }
    if (!phases.implement) continue;
    const reachedPr = Boolean(phases.pr || phases["monitor-merge"] || phases.implement?.draftPr?.number);
    const teardownDone = done(phases.teardown?.status);
    const stalled = Object.values(phases).some((p) => terminalBad(p?.status));
    const hasUnmergedWork = done(phases.implement?.status) && !reachedPr && !teardownDone;
    if (!hasUnmergedWork && !stalled) continue;
    out.set(entry.name, {
      id: entry.name, phases, reachedPr, teardownDone, hasUnmergedWork,
      mergedPr: done(phases["monitor-merge"]?.status),
      disposition: stalled && !reachedPr ? "stalled" : "done-unmerged",
    });
  }
  return out;
}
