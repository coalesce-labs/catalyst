#!/usr/bin/env bun
// ⛔ CTL-2159 — THE NAME IS LEGACY; THIS NO LONGER APPLIES A LINEAR LABEL.
// It still routes through the shared guard, and the guard now PUBLISHES the
// escalation through the CTL-2158 classifier (SYSTEM → retry + the one fleet
// alert, ASK → one ask ticket carrying `blocks`, MOOT → close, HELD → visible).
// The file and its one shell caller (lib/escalate-workflow-scope.sh:63) keep
// their names so the shell surface — which no JS import graph can see — is not
// renamed in the same change that changes its behaviour; the rename belongs with
// the marker-file rename in the consumer phase.
//
// label-needs-human.mjs — CTL-1552 CLI shim. Shell escalation sites (e.g.
// lib/escalate-workflow-scope.sh) call this to apply the needs-human label
// THROUGH the shared guard — the belief-owner check + read-verify applyLabel +
// once-marker in ONE place — instead of hand-rolling a raw
// `linearis issues update --labels needs-human` plus a hand-written
// `.linear-label-needs-human.applied` marker (which bypassed the belief-owner
// gate AND the read-verify, and could desync marker vs. Linear).
//
// Runs under bun (the execution-core runtime): applyLabel's transitive import
// graph reaches `bun:sqlite`. Always exits 0 — fail-open, mirroring the shell
// caller's best-effort `|| true`: a bad arg or a Linear failure must never fail
// the caller's phase.
import { labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";
import { applyLabel } from "./linear-write.mjs";

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const ticket = get("--ticket");
const orchDir = get("--orch-dir");
const reason = get("--reason") ?? "shell-escalation";
// Optional caller-built explanation. Unparseable JSON degrades to undefined so
// the guard falls back to its generic explanation rather than failing the apply.
let explanation;
try {
  const raw = get("--explanation");
  if (raw) explanation = JSON.parse(raw);
} catch {
  explanation = undefined;
}

if (!ticket || !orchDir) {
  console.error("label-needs-human: --ticket and --orch-dir are required (no-op)");
  process.exit(0); // fail-open: a missing arg must not fail the caller's phase
}

try {
  const applied = labelNeedsHumanUnlessBeliefOwner(
    orchDir,
    ticket,
    { applyLabel },
    // CTL-2159: `--reason` is both the site id and the stall reason for this
    // caller — the shell surface has no separate token — so it is passed as both.
    { site: reason, reason, explanation },
  );
  console.error(
    `label-needs-human: ${ticket} needs-human apply -> ${applied ? "applied" : "deferred/no-op"}`,
  );
} catch (err) {
  console.error(`label-needs-human: threw (continuing): ${err?.message}`);
}
process.exit(0);
