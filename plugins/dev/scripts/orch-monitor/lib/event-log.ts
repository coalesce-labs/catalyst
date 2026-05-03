/**
 * Append-only writer for the unified Catalyst event log.
 *
 * Events go to `~/catalyst/events/YYYY-MM.jsonl` — the same file written by
 * `catalyst-state.sh event` for orchestrator/worker lifecycle events. Phase 6
 * (CTL-209) extends the schema with `source`, `id`, `schemaVersion`, and
 * `scope` fields so consumers can filter across multiple sources (github,
 * linear, comms, catalyst).
 *
 * Backward-compatible: top-level `orchestrator` and `worker` fields are kept
 * for one release while consumers migrate to `scope.orchestrator` /
 * `scope.worker`.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface EventScope {
  repo?: string;
  pr?: number;
  ticket?: string;
  orchestrator?: string | null;
  worker?: string | null;
  sha?: string;
  ref?: string;
  environment?: string;
}

export interface GlobalEventEnvelope {
  ts: string;
  id: string;
  schemaVersion: 2;
  source: string;
  event: string;
  scope: EventScope;
  detail: Record<string, unknown>;
  // Backward-compat fields (kept for one release)
  orchestrator: string | null;
  worker: string | null;
}

export type AppendableEvent = Omit<
  GlobalEventEnvelope,
  "ts" | "schemaVersion" | "orchestrator" | "worker"
>;

export interface EventLogLogger {
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface EventLogWriter {
  append(envelope: AppendableEvent): Promise<void>;
}

export interface CreateEventLogWriterOpts {
  /** ~/catalyst directory (events go to {catalystDir}/events/YYYY-MM.jsonl). */
  catalystDir: string;
  /** Override for tests. */
  now?: () => Date;
  logger?: EventLogLogger;
}

export function createEventLogWriter(
  opts: CreateEventLogWriterOpts,
): EventLogWriter {
  const log = opts.logger ?? {};
  const now = opts.now ?? (() => new Date());

  function monthlyFilePath(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return join(opts.catalystDir, "events", `${y}-${m}.jsonl`);
  }

  async function append(envelope: AppendableEvent): Promise<void> {
    const ts = now();
    const full: GlobalEventEnvelope = {
      ts: ts.toISOString(),
      id: envelope.id,
      schemaVersion: 2,
      source: envelope.source,
      event: envelope.event,
      scope: envelope.scope,
      detail: envelope.detail,
      orchestrator: envelope.scope.orchestrator ?? null,
      worker: envelope.scope.worker ?? null,
    };
    const path = monthlyFilePath(ts);
    const line = JSON.stringify(full) + "\n";
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line);
    } catch (err) {
      log.error?.(
        `[event-log] append failed for ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return Promise.resolve();
  }

  return { append };
}

/**
 * Topic naming convention: <source>.<noun>.<verb>
 *
 * Examples for github webhooks:
 *   github.pr.opened, github.pr.closed, github.pr.merged, github.pr.synchronize
 *   github.pr_review.submitted, github.pr_review_thread.resolved
 *   github.check_suite.completed, github.status.<state>
 *   github.push, github.deployment.created, github.deployment_status.<state>
 *   github.issue_comment.created, github.pr_review_comment.created
 */
export const WEBHOOK_SOURCE = "github.webhook";
