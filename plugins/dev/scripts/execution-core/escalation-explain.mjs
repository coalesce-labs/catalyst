#!/usr/bin/env node
// escalation-explain.mjs — CTL-1065 CLI shim. Shell write sites call this to
// produce a validated explanation JSON blob to splice into signal files with jq.
// Always exits 0; degrades rather than dropping a park.
import { coerceExplanation } from "./escalation-explanation.mjs";

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

let observed = {};
try {
  observed = get("--observed") ? JSON.parse(get("--observed")) : {};
} catch {
  observed = {};
}

let attempts = [];
try {
  attempts = get("--attempts") ? JSON.parse(get("--attempts")) : [];
} catch {
  attempts = [];
}

const e = coerceExplanation(
  {
    what_failed: get("--what-failed"),
    observed,
    attempts,
    why_gave_up: get("--why-gave-up"),
    human_question: get("--human-question"),
  },
  { ticket: get("--ticket"), phase: get("--phase") },
);

process.stdout.write(JSON.stringify(e));
process.exit(0);
