#!/usr/bin/env node
// escalation-explain.mjs — CTL-1130 CLI shim. Shell write sites call this to
// produce a validated typed-union explanation JSON blob to splice into signal
// files with jq. Always exits 0; degrades rather than dropping a page.
import { coerceExplanation } from "./escalation-explanation.mjs";

const args = process.argv.slice(2);

const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// Parses a JSON flag value; falls back to `fallback` on invalid/absent JSON.
const getJson = (flag, fallback) => {
  const raw = get(flag);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

// Maps '--can-execute' / '--could-higher-tier-resolve' strings to boolean or
// undefined. Returns undefined (not false) when absent so coerceExplanation
// can distinguish "not set" from "explicitly false" for degrade direction (D5).
const getBool = (flag) => {
  const raw = get(flag);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
};

const escalation_type = get("--type");
const problem = get("--problem") ?? get("--what-failed");
const call_to_action = get("--call-to-action") ?? get("--human-question");

// Optional passthrough fields (D1)
const observed = getJson("--observed", undefined);
const attempts = getJson("--attempts", undefined);

// Type-specific fields
const blocked_capability = get("--blocked-capability");
const instructions = getJson("--instructions", []);
const remediation_then_retry = get("--remediation-then-retry") ?? get("--why-gave-up");
const why_not_auto = get("--why-not-auto");

const recommendation = get("--recommendation");
const risk = get("--risk");
const why_asking = get("--why-asking");
const authorize_label = get("--authorize-label");
const could_higher_tier_resolve = getBool("--could-higher-tier-resolve");
const tried_tiers = getJson("--tried-tiers", []);

const options = getJson("--options", undefined);
const why_you = get("--why-you");

const canExecute = getBool("--can-execute");

const fields = {
  ...(escalation_type != null ? { escalation_type } : {}),
  ...(problem != null ? { problem } : {}),
  ...(call_to_action != null ? { call_to_action } : {}),
  ...(observed != null ? { observed } : {}),
  ...(attempts != null ? { attempts } : {}),
  ...(blocked_capability != null ? { blocked_capability } : {}),
  ...(instructions.length > 0 ? { instructions } : {}),
  ...(remediation_then_retry != null ? { remediation_then_retry } : {}),
  ...(why_not_auto != null ? { why_not_auto } : {}),
  ...(recommendation != null ? { recommendation } : {}),
  ...(risk != null ? { risk } : {}),
  ...(why_asking != null ? { why_asking } : {}),
  ...(authorize_label != null ? { authorize_label } : {}),
  ...(could_higher_tier_resolve != null ? { could_higher_tier_resolve } : {}),
  ...(options != null ? { options } : {}),
  ...(why_you != null ? { why_you } : {}),
};

const ctx = {
  ticket: get("--ticket"),
  phase: get("--phase"),
  ...(canExecute != null ? { canExecute } : {}),
  ...(tried_tiers.length > 0 ? { tried_tiers } : {}),
};

const e = coerceExplanation(fields, ctx);

process.stdout.write(JSON.stringify(e));
process.exit(0);
