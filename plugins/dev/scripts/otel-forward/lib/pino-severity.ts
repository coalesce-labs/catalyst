import type { Severity } from "../../orch-monitor/lib/canonical-event-shared.ts";
import { SEVERITY_NUMBERS } from "../../orch-monitor/lib/canonical-event-shared.ts";

const PINO_LEVEL_TO_TEXT: Record<number, Severity> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

export function pinoLevelToSeverity(level: unknown): { text: Severity; number: number } {
  const t = typeof level === "number" && !Number.isNaN(level) ? PINO_LEVEL_TO_TEXT[level] : undefined;
  const text = t ?? "INFO";
  return { text, number: SEVERITY_NUMBERS[text] };
}
