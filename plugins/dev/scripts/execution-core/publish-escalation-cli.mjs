#!/usr/bin/env bun
// publish-escalation-cli.mjs — the CLI shim SHELL escalation sites use to publish
// an escalation through the shared guard (CTL-1552; renamed from
// `label-needs-human.mjs` by CTL-2161).
//
// ⛔ WHY IT WAS RENAMED AND NOT DELETED. The consumer phase's brief listed this
// file for deletion. It has exactly ONE caller — lib/escalate-workflow-scope.sh —
// and that caller is a SHELL surface, invisible to every JS import graph and to
// the plan's producer regex. Deleting the file would have silently removed the
// only escalation the workflow-scope push failure raises: the phase would fail,
// nothing would be published, and no alert or ask would name it. That is the
// "silent stall" outcome this epic exists to avoid, so the file survives under an
// honest name and the shell caller was updated in the same commit.
//
// What it does NOW (CTL-2159): it routes through the shared guard, which publishes
// the escalation through the CTL-2158 classifier — SYSTEM → retry with backoff
// plus the ONE CTL-2156 fleet alert and zero per-ticket artifacts; ASK → one ask
// ticket carrying `blocks` (CTL-2157); MOOT → close; HELD → recorded, visible.
// It applies NO Linear label.
//
// Runs under bun (the execution-core runtime): the guard's transitive import graph
// reaches `bun:sqlite`. Always exits 0 — fail-open, mirroring the shell caller's
// best-effort `|| true`: a bad arg or a Linear failure must never fail the
// caller's phase.
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
  console.error("publish-escalation: --ticket and --orch-dir are required (no-op)");
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
    `publish-escalation: ${ticket} -> ${applied ? "published" : "deferred/no-op"}`,
  );
} catch (err) {
  console.error(`publish-escalation: threw (continuing): ${err?.message}`);
}
process.exit(0);
