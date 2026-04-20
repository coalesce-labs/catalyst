export type CommsMessageType =
  | "proposal"
  | "question"
  | "answer"
  | "ack"
  | "info"
  | "attention"
  | "done";

export const COMMS_MESSAGE_TYPES: readonly CommsMessageType[] = [
  "proposal",
  "question",
  "answer",
  "ack",
  "info",
  "attention",
  "done",
] as const;

export interface CommsParticipant {
  name: string;
  joined: string;
  ttl: number;
  lastSeen: string;
  capabilities: string;
  parent: string | null;
  orch: string | null;
  status: "active" | "left";
}

export interface CommsMessage {
  id: string;
  from: string;
  to: string;
  ch: string;
  parent: string | null;
  orch: string | null;
  ts: string;
  type: CommsMessageType;
  re: string | null;
  body: string;
}

export interface CommsChannelSummary {
  name: string;
  topic: string | null;
  created: string | null;
  participantCount: number;
  messageCount: number;
  lastActivity: string | null;
  orchId: string | null;
  archived: boolean;
  authors: string[];
}

export interface CommsChannelDetail extends CommsChannelSummary {
  participants: CommsParticipant[];
  messages: CommsMessage[];
  total: number;
  tailOffset: number;
}

export interface CommsParticipantDetail {
  name: string;
  channels: string[];
  aggregateCapabilities: string[];
  lastSeen: string | null;
}
