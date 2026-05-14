// broker-interests-reader.ts — parse ~/catalyst/broker-interests.json (CTL-392).
//
// The broker writes its registered interests as a 2-tuple array (NOT an object
// map): `[[interestKey, record], …]`. Each record describes one wake interest
// (PR lifecycle, comms lifecycle, ticket lifecycle, or a free-text "prose"
// interest). The HUD dashboard reads this file to surface what the broker is
// actually waiting for.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type InterestType =
  | "pr_lifecycle"
  | "comms_lifecycle"
  | "ticket_lifecycle"
  | null;

export interface BrokerInterest {
  key: string;
  notify_event: string | null;
  prompt: string;
  context: {
    pr_numbers?: number[];
    tickets?: string[];
  } | null;
  orchestrator: string | null;
  session_id: string | null;
  persistent: boolean;
  interest_type: InterestType;
  pr_numbers: number[] | null;
  repo: string | null;
  base_branches: Array<{ pr: number; base: string }> | null;
  tickets: string[] | null;
  wake_on: string[] | null;
}

export function brokerInterestsFilePath(): string {
  const dir = process.env.CATALYST_DIR ?? resolve(homedir(), "catalyst");
  return resolve(dir, "broker-interests.json");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumberArray(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const n of v) {
    if (typeof n === "number" && Number.isFinite(n)) out.push(n);
  }
  return out.length > 0 ? out : null;
}
function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s === "string") out.push(s);
  }
  return out.length > 0 ? out : null;
}
function asInterestType(v: unknown): InterestType {
  if (v === "pr_lifecycle" || v === "comms_lifecycle" || v === "ticket_lifecycle") return v;
  return null;
}
function asBaseBranches(v: unknown): Array<{ pr: number; base: string }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ pr: number; base: string }> = [];
  for (const e of v) {
    if (e && typeof e === "object") {
      const obj = e as Record<string, unknown>;
      if (typeof obj.pr === "number" && typeof obj.base === "string") {
        out.push({ pr: obj.pr, base: obj.base });
      }
    }
  }
  return out.length > 0 ? out : null;
}
function asContext(v: unknown): BrokerInterest["context"] {
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const out: NonNullable<BrokerInterest["context"]> = {};
  const prs = asNumberArray(obj.pr_numbers);
  const tickets = asStringArray(obj.tickets);
  if (prs) out.pr_numbers = prs;
  if (tickets) out.tickets = tickets;
  return Object.keys(out).length > 0 ? out : null;
}

function parseRecord(key: string, raw: unknown): BrokerInterest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    key,
    notify_event: asString(r.notify_event),
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    context: asContext(r.context),
    orchestrator: asString(r.orchestrator),
    session_id: asString(r.session_id),
    persistent: r.persistent === true,
    interest_type: asInterestType(r.interest_type),
    pr_numbers: asNumberArray(r.pr_numbers),
    repo: asString(r.repo),
    base_branches: asBaseBranches(r.base_branches),
    tickets: asStringArray(r.tickets),
    wake_on: asStringArray(r.wake_on),
  };
}

export function readBrokerInterests(path?: string): BrokerInterest[] {
  const target = path ?? brokerInterestsFilePath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BrokerInterest[] = [];
  for (const entry of parsed as unknown[]) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const tuple = entry as unknown[];
    const keyRaw = tuple[0];
    const recordRaw = tuple[1];
    if (typeof keyRaw !== "string") continue;
    const rec = parseRecord(keyRaw, recordRaw);
    if (rec) out.push(rec);
  }
  return out;
}
