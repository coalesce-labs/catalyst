#!/usr/bin/env node
// boot-resume-approve.mjs — CTL-1443: the operator tooling the CTL-644 approval
// gate always referenced but never had ("empty sentinel written by the operator
// (or a HUD button)" — nothing wrote it). List gated tickets; approve one.
//
//   boot-resume-approve.mjs --list [--orch-dir D]
//   boot-resume-approve.mjs <ticket> [--orch-dir D]
//
// Approval writes the .boot-resume-approved sentinel; the daemon's every-tick
// processApprovedResumes dispatches the gated phase (no restart needed).
//
// STANDALONE on purpose: boot-resume.mjs transitively imports bun-only modules
// (scheduler → bun:sqlite), and this CLI must run under plain node. The two
// marker paths are a stable contract (boot-resume.mjs bootResumePendingPath /
// bootResumeApprovedPath — change them together).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
function get(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const orchDir =
  get("--orch-dir") ??
  process.env.CATALYST_ORCHESTRATOR_DIR ??
  join(process.env.CATALYST_DIR ?? join(homedir(), "catalyst"), "execution-core");

const pendingPath = (t) => join(orchDir, "workers", t, ".boot-resume-pending-approval");
const approvedPath = (t) => join(orchDir, "workers", t, ".boot-resume-approved");

if (argv.includes("--list")) {
  let tickets = [];
  try {
    tickets = readdirSync(join(orchDir, "workers"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* no workers dir → empty */
  }
  const gates = [];
  for (const t of tickets) {
    if (!existsSync(pendingPath(t))) continue;
    let pending = {};
    try {
      pending = JSON.parse(readFileSync(pendingPath(t), "utf8")) ?? {};
    } catch {
      /* unreadable marker still listed */
    }
    const requestedMs = Date.parse(pending.requestedAt ?? "") || null;
    gates.push({
      ticket: t,
      phase: pending.phase ?? "?",
      age: requestedMs ? `${Math.round((Date.now() - requestedMs) / 3600e3)}h` : "?",
      approved: existsSync(approvedPath(t)),
      surfaced: Boolean(pending.surfacedAt),
    });
  }
  if (gates.length === 0) {
    process.stdout.write("no pending boot-resume approval gates\n");
    process.exit(0);
  }
  for (const g of gates) {
    process.stdout.write(
      `${g.ticket}\tphase=${g.phase}\tage=${g.age}\tapproved=${g.approved}\tsurfaced=${g.surfaced ? "yes" : "no"}\n`,
    );
  }
  process.exit(0);
}

const orchDirFlagValue = get("--orch-dir");
const ticket = argv.find((a) => !a.startsWith("--") && a !== orchDirFlagValue);
if (!ticket) {
  process.stderr.write("usage: boot-resume-approve.mjs <ticket> | --list [--orch-dir D]\n");
  process.exit(2);
}
if (!existsSync(pendingPath(ticket))) {
  process.stderr.write(`boot-resume-approve: ${ticket}: no-pending-gate\n`);
  process.exit(1);
}
try {
  writeFileSync(approvedPath(ticket), "");
} catch (err) {
  process.stderr.write(`boot-resume-approve: ${ticket}: ${err.message}\n`);
  process.exit(1);
}
process.stdout.write(`${ticket} approved — the daemon's next tick dispatches the gated phase\n`);
