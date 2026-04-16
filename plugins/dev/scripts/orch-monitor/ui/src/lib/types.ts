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

export interface TaskSummary {
  total: number;
  completed: number;
  inProgress: number;
  activeTask: string | null;
}

export interface WorkerActivity {
  currentTool: string | null;
  lastText: string | null;
  eventCount: number;
  toolCalls: number;
  turns: number;
  streamSizeBytes: number;
  hasRetries: boolean;
  taskSummary?: TaskSummary | null;
}

export interface StreamEvent {
  ts: number;
  type:
    | "tool_start"
    | "tool_end"
    | "text"
    | "turn"
    | "init"
    | "retry"
    | "result"
    | "rate_limit";
  tool?: string;
  toolInput?: string;
  text?: string;
  /** Tool names invoked in this assistant turn (extracted from message.content) */
  turnTools?: string[];
  retryInfo?: { attempt: number; maxRetries: number; error: string };
  rateLimitInfo?: { status: string; resetsAt?: number };
  usage?: Record<string, unknown>;
  sessionId?: string;
}

export interface WorkerTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks?: string[];
  blockedBy?: string[];
  owner?: string;
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
  activity?: WorkerActivity | null;
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
  workspace: string;
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

export type SessionKind = "orchestrator" | "worker" | "standalone";

export interface SessionState {
  sessionId: string;
  workflowId: string | null;
  ticket: string | null;
  label: string | null;
  skillName: string | null;
  status: string;
  phase: number;
  pid: number | null;
  alive: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  timeSinceUpdate: number;
  cost: WorkerCost | null;
  pr: { number: number; url: string | null } | null;
  cwd: string | null;
  gitBranch: string | null;
}

export function sessionKind(s: SessionState): SessionKind {
  if (s.skillName === "orchestrate") return "orchestrator";
  if (s.workflowId) return "worker";
  return "standalone";
}

export const SESSION_TIME_FILTERS = ["active", "1h", "24h", "48h", "all"] as const;
export type SessionTimeFilter = (typeof SESSION_TIME_FILTERS)[number];

export type ConnectionStatus = "connecting" | "connected" | "reconnecting";
export type TabId = "overview" | "workers" | "timeline" | "events";

export interface CollectedAttention {
  orchId: string;
  ticket: string;
  reason: string;
  severity: "error" | "warning";
}
