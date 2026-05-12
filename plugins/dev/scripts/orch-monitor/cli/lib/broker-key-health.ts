// broker-key-health.ts — read + render broker key-health for the HUD (CTL-343).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ProbeStatus = "ok" | "missing" | "unauthorized" | "error" | "pending";

export interface BrokerKeyHealth {
  groq?: {
    present: boolean;
    source: string | null;
    prefix: string | null;
    probeStatus: ProbeStatus;
    probeError?: string | null;
    probeAt?: string | null;
    modelCount?: number | null;
  };
}

/** Path of the broker's state file (override via $BROKER_STATE_FILE). */
export function brokerStateFilePath(): string {
  if (process.env.BROKER_STATE_FILE) return process.env.BROKER_STATE_FILE;
  const dir = process.env.CATALYST_DIR ?? resolve(homedir(), "catalyst");
  return resolve(dir, "broker.state.json");
}

export function readBrokerKeyHealth(path?: string): BrokerKeyHealth | null {
  const target = path ?? brokerStateFilePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (parsed && typeof parsed === "object" && "keyHealth" in parsed) {
      const kh = (parsed as { keyHealth?: BrokerKeyHealth }).keyHealth;
      return kh ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Three-letter chip label for a probe status. */
export function chipLabel(status: ProbeStatus): string {
  switch (status) {
    case "ok": return "OK";
    case "missing": return "MISS";
    case "unauthorized": return "401";
    case "error": return "ERR";
    case "pending": return "...";
  }
}

/** Ink color name for a probe status. */
export function chipColor(status: ProbeStatus): string {
  switch (status) {
    case "ok": return "green";
    case "missing": return "yellow";
    case "unauthorized": return "red";
    case "error": return "red";
    case "pending": return "cyan";
  }
}
