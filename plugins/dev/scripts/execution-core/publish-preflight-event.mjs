import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getHostName, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const PUBLISH_PREFLIGHT_WOULD_BLOCK = "publish.preflight.would-block";
export const PUBLISH_PREFLIGHT_BLOCKED = "publish.preflight.blocked";

export function buildPublishPreflightEnvelope({ action, ticket, phase, verdict, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    ts, id: randomBytes(8).toString("hex"), observedTs: ts,
    severityText: action === "blocked" ? "WARN" : "INFO",
    severityNumber: action === "blocked" ? 13 : 9,
    traceId: null, spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": action === "blocked" ? PUBLISH_PREFLIGHT_BLOCKED : PUBLISH_PREFLIGHT_WOULD_BLOCK,
      "event.entity": "repository", "event.action": action, "event.label": verdict?.slug ?? ticket,
    },
    body: { payload: { ticket, phase, host: getHostName(), ...verdict } },
  };
}

export function appendPublishPreflightEvent({ logPath = getEventLogPath(), ...fields } = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(buildPublishPreflightEnvelope(fields))}\n`);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "publish-preflight: event append failed");
    return false;
  }
}

export const appendPublishPreflightBlockedEvent = (fields) => appendPublishPreflightEvent({ ...fields, action: "blocked" });
export const appendPublishPreflightWouldBlockEvent = (fields) => appendPublishPreflightEvent({ ...fields, action: "would-block" });
