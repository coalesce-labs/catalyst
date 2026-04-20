import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CommsChannelDetail,
  CommsChannelSummary,
  CommsMessage,
  CommsParticipant,
  CommsParticipantDetail,
} from "./comms-types";
import { COMMS_MESSAGE_TYPES } from "./comms-types";

export const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name);
}

export function parseOrchIdFromChannelName(name: string): string | null {
  if (!name.startsWith("orch-")) return null;
  const rest = name.slice(5);
  return rest.length > 0 ? rest : null;
}

const MESSAGE_TYPE_SET = new Set<string>(COMMS_MESSAGE_TYPES);

export function parseJsonlLine(line: string): CommsMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.ts !== "string") return null;
  if (typeof m.type !== "string" || !MESSAGE_TYPE_SET.has(m.type)) return null;
  if (typeof m.from !== "string" || typeof m.body !== "string") return null;
  return {
    id: m.id,
    from: m.from,
    to: typeof m.to === "string" ? m.to : "all",
    ch: typeof m.ch === "string" ? m.ch : "",
    parent: typeof m.parent === "string" ? m.parent : null,
    orch: typeof m.orch === "string" ? m.orch : null,
    ts: m.ts,
    type: m.type as CommsMessage["type"],
    re: typeof m.re === "string" ? m.re : null,
    body: m.body,
  };
}

export interface ParticipantStaleness {
  stale: boolean;
  ageMs: number;
}

export function participantStaleness(
  p: Pick<CommsParticipant, "lastSeen" | "ttl">,
  nowMs: number,
): ParticipantStaleness {
  const lastSeenMs = Date.parse(p.lastSeen);
  if (Number.isNaN(lastSeenMs)) return { stale: true, ageMs: Infinity };
  const ageMs = nowMs - lastSeenMs;
  return { stale: ageMs > p.ttl * 1000, ageMs };
}

export interface CommsReaderOptions {
  commsDir?: string;
}

export function resolveCommsDir(): string {
  const override = process.env.CATALYST_COMMS_DIR;
  if (override) return override;
  const catalystDir = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
  return join(catalystDir, "comms");
}

interface RegistryEntry {
  name?: string;
  topic?: string | null;
  created?: string | null;
  participants?: CommsParticipant[];
}

type Registry = Record<string, RegistryEntry>;

function readRegistry(registryPath: string): Registry {
  if (!existsSync(registryPath)) return {};
  try {
    const raw = readFileSync(registryPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Registry;
    }
    return {};
  } catch {
    return {};
  }
}

function readChannelFile(path: string): { messages: CommsMessage[]; tailOffset: number } {
  if (!existsSync(path)) return { messages: [], tailOffset: 0 };
  const raw = readFileSync(path, "utf-8");
  const tailOffset = Buffer.byteLength(raw);
  if (!raw) return { messages: [], tailOffset };
  const messages: CommsMessage[] = [];
  for (const line of raw.split("\n")) {
    const parsed = parseJsonlLine(line);
    if (parsed) messages.push(parsed);
  }
  return { messages, tailOffset };
}

function maxLastSeen(participants: CommsParticipant[] | undefined): string | null {
  if (!participants || participants.length === 0) return null;
  let max: string | null = null;
  let maxMs = -Infinity;
  for (const p of participants) {
    const ms = Date.parse(p.lastSeen ?? "");
    if (!Number.isNaN(ms) && ms > maxMs) {
      maxMs = ms;
      max = p.lastSeen;
    }
  }
  return max;
}

export interface CommsReader {
  listChannels(): Promise<CommsChannelSummary[]>;
  getChannel(
    name: string,
    opts?: { limit?: number },
  ): Promise<CommsChannelDetail | null>;
  tailChannel(
    name: string,
    fromOffset: number,
  ): Promise<{ messages: CommsMessage[]; newOffset: number }>;
  getParticipant(name: string): Promise<CommsParticipantDetail | null>;
}

export function createCommsReader(opts: CommsReaderOptions = {}): CommsReader {
  const commsDir = opts.commsDir ?? resolveCommsDir();
  const registryPath = join(commsDir, "channels.json");
  const channelsDir = join(commsDir, "channels");

  function channelPath(name: string): string {
    return join(channelsDir, `${name}.jsonl`);
  }

  function listChannelsSync(): CommsChannelSummary[] {
    const registry = readRegistry(registryPath);
    const summaries: CommsChannelSummary[] = [];
    for (const [name, entry] of Object.entries(registry)) {
      if (!isValidChannelName(name)) continue;
      const { messages } = readChannelFile(channelPath(name));
      const participants = Array.isArray(entry.participants) ? entry.participants : [];
      const authors = Array.from(new Set(messages.map((m) => m.from))).sort();
      const lastMsgTs = messages.length > 0 ? messages[messages.length - 1].ts : null;
      summaries.push({
        name,
        topic: entry.topic ?? null,
        created: entry.created ?? null,
        participantCount: participants.length,
        messageCount: messages.length,
        lastActivity: lastMsgTs ?? maxLastSeen(participants),
        orchId: parseOrchIdFromChannelName(name),
        archived: false,
        authors,
      });
    }
    summaries.sort((a, b) => {
      const at = a.lastActivity ? Date.parse(a.lastActivity) : 0;
      const bt = b.lastActivity ? Date.parse(b.lastActivity) : 0;
      return bt - at;
    });
    return summaries;
  }

  function getChannelSync(
    name: string,
    { limit = 200 }: { limit?: number } = {},
  ): CommsChannelDetail | null {
    if (!isValidChannelName(name)) return null;
    const registry = readRegistry(registryPath);
    const entry = registry[name];
    if (!entry) return null;
    const { messages, tailOffset } = readChannelFile(channelPath(name));
    const participants = Array.isArray(entry.participants) ? entry.participants : [];
    const limited = limit > 0 && messages.length > limit ? messages.slice(-limit) : messages;
    const authors = Array.from(new Set(messages.map((m) => m.from))).sort();
    const lastMsgTs = messages.length > 0 ? messages[messages.length - 1].ts : null;
    return {
      name,
      topic: entry.topic ?? null,
      created: entry.created ?? null,
      participantCount: participants.length,
      messageCount: messages.length,
      lastActivity: lastMsgTs ?? maxLastSeen(participants),
      orchId: parseOrchIdFromChannelName(name),
      archived: false,
      authors,
      participants,
      messages: limited,
      total: messages.length,
      tailOffset,
    };
  }

  function tailChannelSync(
    name: string,
    fromOffset: number,
  ): { messages: CommsMessage[]; newOffset: number } {
    if (!isValidChannelName(name)) return { messages: [], newOffset: fromOffset };
    const path = channelPath(name);
    if (!existsSync(path)) return { messages: [], newOffset: 0 };
    const stats = statSync(path);
    const size = stats.size;
    if (size < fromOffset) {
      const { messages, tailOffset } = readChannelFile(path);
      return { messages, newOffset: tailOffset };
    }
    if (size === fromOffset) return { messages: [], newOffset: fromOffset };

    const bytesToRead = size - fromOffset;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, bytesToRead, fromOffset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf-8");
    const messages: CommsMessage[] = [];
    let consumed = 0;
    const lines = text.split("\n");
    // Last segment may be a partial line not yet flushed — leave it unconsumed
    // so we pick it up on the next tick.
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      consumed += Buffer.byteLength(line) + 1;
      const parsed = parseJsonlLine(line);
      if (parsed) messages.push(parsed);
    }
    return { messages, newOffset: fromOffset + consumed };
  }

  function getParticipantSync(name: string): CommsParticipantDetail | null {
    const registry = readRegistry(registryPath);
    const channels: string[] = [];
    const caps = new Set<string>();
    let latestSeen: string | null = null;
    let latestMs = -Infinity;
    for (const [channelName, entry] of Object.entries(registry)) {
      if (!Array.isArray(entry.participants)) continue;
      const match = entry.participants.find((p) => p.name === name);
      if (!match) continue;
      channels.push(channelName);
      for (const token of (match.capabilities || "").split(/\s+/)) {
        if (token) caps.add(token);
      }
      const ms = Date.parse(match.lastSeen ?? "");
      if (!Number.isNaN(ms) && ms > latestMs) {
        latestMs = ms;
        latestSeen = match.lastSeen;
      }
    }
    if (channels.length === 0) return null;
    return {
      name,
      channels,
      aggregateCapabilities: Array.from(caps).sort(),
      lastSeen: latestSeen,
    };
  }

  const listChannels = () => Promise.resolve(listChannelsSync());
  const getChannel = (name: string, opts?: { limit?: number }) =>
    Promise.resolve(getChannelSync(name, opts));
  const tailChannel = (name: string, fromOffset: number) =>
    Promise.resolve(tailChannelSync(name, fromOffset));
  const getParticipant = (name: string) => Promise.resolve(getParticipantSync(name));

  return { listChannels, getChannel, tailChannel, getParticipant };
}
