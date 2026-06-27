/**
 * Canonical OTel-shaped event envelope.
 *
 * Modeled directly on OTel `LogRecord` so the on-disk JSONL is a clean
 * projection — a future sidecar can transcode to OTLP without translation.
 *
 * Trace/span IDs are derived deterministically from orchestrator/worker
 * identifiers so any producer (TS or bash) can compute the same IDs from
 * the same inputs without coordination. Per-event `id` (CTL-344) is
 * generated at build time; one UUIDv4 per emission.
 *
 * Primitive helpers (`sha256Hex`, `severityNumber`, `deriveTraceId`,
 * `deriveSpanId`, `generateEventId`, `synthesizeEventId`) live in
 * `./canonical-event-shared` so the broker daemon can import the same
 * code without duplicating it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  type Severity,
  buildCatalystResource,
  generateEventId,
  severityNumber,
} from "./canonical-event-shared";

export {
  type Severity,
  SEVERITY_NUMBERS,
  sha256Hex,
  severityNumber,
  deriveTraceId,
  deriveSpanId,
  generateEventId,
  synthesizeEventId,
  hostName,
  hostId,
} from "./canonical-event-shared";

export interface Resource {
  "service.name": string;
  "service.namespace": "catalyst";
  "service.version": string;
  // CTL-852: host identity fields, always present on canonical events.
  "host.name": string;
  "host.id": string;
  // CTL-1368: node CLASS (developer|worker|monitor) — the role this node plays.
  // Stamped by buildCatalystResource (always present when the resource is built
  // through it). Optional so external (webhook/broker-daemon) events that build
  // a bare resource block remain valid.
  "catalyst.node.class"?: string;
  // CTL-1262: stable Catalyst node name, distinct from the OS hostname
  // (host.name). Resolved the same way as getHostName() / hostName()
  // (CATALYST_HOST_NAME env -> catalyst.host.name Layer-2 config ->
  // os.hostname() first DNS label) and NEVER derived from a Tailscale device
  // name. Optional so external (webhook/broker-daemon) events that build a bare
  // resource block remain valid; the otel-forward event path always sets it.
  "catalyst.node.name"?: string;
  // CTL-636: optional orchestration-context resource keys. Present only when
  // the event carries the corresponding data; omitted otherwise so external
  // (webhook / broker-daemon) events keep the bare 3-key block.
  "project"?: string;
  "linear.key"?: string;
  "catalyst.orchestration"?: string;
}

export interface Attributes {
  // catalyst-internal classifier
  "event.name": string;
  "event.entity"?: string;
  "event.action"?: string;
  "event.label"?: string;
  "event.value"?: string | number;
  "event.channel"?: "webhook" | "sme.io";

  // catalyst entities
  "catalyst.orchestrator.id"?: string;
  "catalyst.worker.ticket"?: string;
  "catalyst.session.id"?: string;
  "catalyst.phase"?: number;

  // VCS semconv (OTel published)
  "vcs.repository.name"?: string;
  "vcs.pr.number"?: number;
  "vcs.ref.name"?: string;
  "vcs.revision"?: string;

  // CI/CD semconv (OTel published)
  "cicd.pipeline.run.id"?: number;
  "cicd.pipeline.run.status"?: string;
  "cicd.pipeline.run.conclusion"?: string;
  "cicd.pipeline.name"?: string;

  // Linear (catalyst-defined; no OTel semconv yet)
  "linear.issue.identifier"?: string;
  "linear.issue.id"?: string;
  "linear.team.key"?: string;
  "linear.actor.id"?: string;

  // Deployment semconv (OTel published)
  "deployment.environment"?: string;
  "deployment.id"?: number;

  // Claude Code metadata (CTL-374). PII note: cost is intentionally absent
  // here — `cost_usd` lives in `body.payload` only because the OTLP forwarder
  // strips body.payload before sending events off the local machine.
  "claude.session.id"?: string;
  "claude.model"?: string;
  "claude.context.used_pct"?: number;
  "claude.context.tokens"?: number;
  "claude.turn"?: number;
}

export interface Body {
  message?: string;
  payload?: unknown;
}

export interface CanonicalEvent {
  ts: string;
  /** Per-event UUIDv4. Generated at build time; maps to OTLP LogRecord.logRecordUid. */
  id: string;
  observedTs?: string;
  severityText: Severity;
  severityNumber: number;
  traceId: string | null;
  spanId: string | null;
  parentSpanId?: string | null;
  /** CTL-1135: id of the triggering event (additive; null when absent). */
  caused_by?: string | null;
  resource: Resource;
  attributes: Attributes;
  body: Body;
}

export interface BuildInput {
  ts: string;
  observedTs?: string;
  severityText: Severity;
  traceId: string | null;
  spanId: string | null;
  parentSpanId?: string | null;
  causedBy?: string | null;
  resource: {
    "service.name": string;
    "service.version"?: string;
    "project"?: string;
    "linear.key"?: string;
    "catalyst.orchestration"?: string;
  };
  attributes: Attributes;
  body: Body;
}

let cachedVersion: string | null = null;

/**
 * Reads the catalyst-dev plugin version from `.claude-plugin/plugin.json`,
 * cached after first read. Falls back to the orch-monitor `package.json`
 * `version` (if present) and finally to "0.0.0" when neither is reachable.
 */
export function pluginVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  const candidates = [
    resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", ".claude-plugin", "plugin.json"),
    resolve(dirname(new URL(import.meta.url).pathname), "..", "package.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof (parsed as { version: unknown }).version === "string"
      ) {
        cachedVersion = (parsed as { version: string }).version;
        return cachedVersion;
      }
    } catch {
      // try next candidate
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/** CTL-636: pull `project=<val>` out of the ambient OTEL_RESOURCE_ATTRIBUTES
 *  env (set by phase-agent-dispatch for --bg workers and by direnv for
 *  interactive sessions). Mirrors the bash parse in emit-otel-event.sh:82-88. */
function projectFromEnv(): string | undefined {
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (!raw) return undefined;
  const m = raw.match(/(?:^|,)project=([^,]+)/);
  return m ? m[1] : undefined;
}

/**
 * Build a canonical event with defaults applied:
 *   - id from generateEventId() (CTL-344)
 *   - severityNumber from severityText
 *   - observedTs defaults to ts
 *   - resource.service.namespace = "catalyst"
 *   - resource.service.version defaults to pluginVersion()
 */
export function buildCanonicalEvent(input: BuildInput): CanonicalEvent {
  const observedTs = input.observedTs ?? input.ts;
  const version = input.resource["service.version"] ?? pluginVersion();

  // `as unknown as Resource`: the shared builder returns Record<string, unknown> (it can't
  // import the Resource type without a cycle), so bridge the index-signature gap. The
  // runtime shape IS a valid Resource — serviceVersion is always passed here.
  const resource: Resource = buildCatalystResource({
    serviceName: input.resource["service.name"],
    serviceVersion: version,
  }) as unknown as Resource;
  // CTL-636: promote orchestration context into resource. Explicit resource
  // input wins; otherwise fall back to the matching attribute (TS emitters
  // already set these) or the ambient env (project only).
  const project = input.resource["project"] ?? projectFromEnv();
  if (project) resource["project"] = project;
  const linearKey =
    input.resource["linear.key"] ?? input.attributes["linear.issue.identifier"];
  if (linearKey) resource["linear.key"] = linearKey;
  const catOrch =
    input.resource["catalyst.orchestration"] ?? input.attributes["catalyst.orchestrator.id"];
  if (catOrch) resource["catalyst.orchestration"] = catOrch;

  const event: CanonicalEvent = {
    ts: input.ts,
    id: generateEventId(),
    observedTs,
    severityText: input.severityText,
    severityNumber: severityNumber(input.severityText),
    traceId: input.traceId,
    spanId: input.spanId,
    caused_by: input.causedBy ?? null,
    resource,
    attributes: input.attributes,
    body: input.body,
  };
  if (input.parentSpanId !== undefined) {
    event.parentSpanId = input.parentSpanId;
  }
  return event;
}

/** CTL-1122: event name for the periodic monitor heartbeat. */
export const MONITOR_HEARTBEAT_EVENT = "monitor.heartbeat";

/**
 * CTL-1122: the periodic `catalyst.monitor` heartbeat. A SURVIVING process (the broker)
 * reads its recency to detect a monitor death/wedge from the log — the monitor's own
 * `kind:"self"` health probe reports up iff this process answers, so it cannot observe
 * its own death (the 11h-outage SPOF). `service.name` is `catalyst.monitor` for parity
 * with the `catalyst.broker` / `catalyst.execution-core` recency matchers. Pure factory
 * (mirrors the CTL-1171 broker `buildBrokerHeartbeatEvent` pattern).
 */
export function buildMonitorHeartbeatEvent(nowIso: string): CanonicalEvent {
  return buildCanonicalEvent({
    ts: nowIso,
    severityText: "INFO",
    traceId: null,
    spanId: null,
    resource: { "service.name": "catalyst.monitor" },
    attributes: {
      "event.name": MONITOR_HEARTBEAT_EVENT,
      "event.entity": "monitor",
      "event.action": "heartbeat",
    },
    body: { payload: null },
  });
}
