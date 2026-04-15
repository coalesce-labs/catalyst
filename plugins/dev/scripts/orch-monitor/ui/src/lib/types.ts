export interface DefinitionOfDone {
  testsWrittenFirst?: boolean;
  unitTests?: { exists?: boolean; count?: number };
  apiTests?: { exists?: boolean; count?: number; reason?: string };
  functionalTests?: { exists?: boolean; count?: number; reason?: string };
  typeCheck?: { passed?: boolean };
  securityReview?: { passed?: boolean };
  codeReview?: { passed?: boolean; findings?: number };
  rewardHackingScan?: { passed?: boolean; violations?: number };
}

export interface WorkerCost {
  costUSD: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface WorkerState {
  ticket: string;
  status: string;
  phase: number;
  wave: number | null;
  pid: number | null;
  alive: boolean;
  pr: {
    number: number;
    url: string;
    state?: string;
    title?: string;
    ciStatus?: string;
    mergedAt?: string;
  } | null;
  startedAt: string;
  updatedAt: string;
  timeSinceUpdate: number;
  lastHeartbeat: string | null;
  definitionOfDone: DefinitionOfDone;
  phaseTimestamps?: Record<string, string>;
  completedAt?: string | null;
  cost?: WorkerCost | null;
  parseError?: string;
  prState?: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
  prMergedAt?: string | null;
}

export interface Wave {
  wave: number;
  status: string;
  tickets: string[];
  completedAt?: string;
  dependsOn?: number[];
}

export interface OrchestratorState {
  id: string;
  path: string;
  startedAt: string;
  currentWave: number;
  totalWaves: number;
  waves: Wave[];
  workers: Record<string, WorkerState>;
  dashboard: string | null;
  briefings: Record<number, string>;
  attention: AttentionItem[];
}

export interface AttentionItem {
  id?: string;
  ticket?: string;
  workerName?: string;
  reason?: string;
  message?: string;
  type?: string;
}

export interface MonitorSnapshot {
  timestamp: string;
  orchestrators: OrchestratorState[];
}

export interface WorkerAnalytics {
  ticket?: string;
  costUSD?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  durationMs?: number;
  toolUsage?: Record<string, number>;
}

export interface LinearTicket {
  key: string;
  title: string;
  url: string;
  project?: string;
  labels?: string[];
}

export interface EventEntry {
  when: string;
  kind: string;
  message: string;
  ticket?: string;
  orchId?: string;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";
export type TabId = "overview" | "workers" | "timeline" | "events";

export interface CollectedAttention {
  orchId: string;
  ticket: string;
  reason: string;
  severity: "error" | "warning";
}
