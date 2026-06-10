// cluster-helpers.ts — CTL-865. Pure UI helpers for the cluster board tab.
import type { Liveness } from "../../../lib/cluster-data";

export const MONITOR_PORT = 7400;

export function monitorUrlForHost(host: string, ticket?: string): string {
  const base = `http://${host}:${MONITOR_PORT}/`;
  return ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;
}

const LIVENESS_COLOR: Record<Liveness, string> = {
  live: "#41bd7d",
  degraded: "#d9a843",
  offline: "#e36b6b",
} as const;

export const livenessColor = (l: Liveness): string => LIVENESS_COLOR[l];

export const livenessLabel = (l: Liveness): string => l;
