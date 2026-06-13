// Type declarations for journey.mjs (CTL-1100).
// Bun:sqlite-free (uses sqlite3 binary via ticket-runs.mjs); safe for static
// import in server.ts. Keep in sync with journey.mjs.

export interface JourneyHop {
  phase: string;
  eventType: string;
  ts: string;
  bg_job_id?: string | null;
  generation?: number | null;
  reason?: string | null;
  blockers?: string[] | null;
}

export interface GateChecklistItem {
  phase: string;
  signalStatus: string | null;
  satisfied: boolean;
}

export interface GateChecklist {
  nextPhase: string | null;
  checklist: GateChecklistItem[];
  remediateCycles: number;
}

export interface VerifyVerdictDetail {
  verdict: string | null;
  regressionRisk: number | null;
  highFindings: number;
  reason: string | null;
}

export interface UnblockHint {
  kind: "operator-note" | "held-reason";
  note?: string;
  reason?: string | null;
  blockers?: string[] | null;
  respondedAt?: string;
}

export interface Journey {
  ticket: string;
  hops: JourneyHop[];
  gates: GateChecklist;
  verifyVerdict: VerifyVerdictDetail;
  remediateCycles: number;
  unblockHints: UnblockHint[];
  hosts: string[];
}

export interface JourneyOptions {
  workersDir?: string;
  orchDir?: string;
  eventLogPath?: string;
  dbPath?: string;
}

export declare function scanHops(ticket: string, opts?: { eventLogPath?: string }): JourneyHop[];
export declare function dedupeHops(hops: JourneyHop[]): JourneyHop[];
export declare function readVerifyVerdictDetail(ticket: string, opts?: { orchDir?: string }): VerifyVerdictDetail;
export declare function buildGateChecklist(ticket: string, opts?: { orchDir?: string; eventLogPath?: string }): GateChecklist;
export declare function collectUnblockHints(ticket: string, opts?: { orchDir?: string; hops?: JourneyHop[] }): UnblockHint[];
export declare function assembleJourney(ticket: string, opts?: JourneyOptions): Promise<Journey>;
