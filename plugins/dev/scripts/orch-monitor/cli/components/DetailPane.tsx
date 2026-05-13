import { Box, Text, useStdout } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { formatDateTime, formatDetailBody } from "../lib/format.ts";

export interface DetailPaneProps {
  event: CanonicalEvent;
  scrollTop: number;
  maxHeight: number;
}

type Line =
  | { k: "sep" }
  | { k: "title"; name: string; ts: string; sev: string }
  | { k: "field"; label: string; value: string; color?: string }
  | { k: "text"; value: string; dim?: boolean }
  | { k: "hint" };

const SEV_COLOR: Record<string, string> = {
  ERROR: "red", WARN: "yellow", INFO: "green", DEBUG: "gray",
};

const LABEL_W = 14;

export function buildDetailLines(event: CanonicalEvent, cols: number): Line[] {
  const attrs = event.attributes ?? {};
  const name = attrs["event.name"] ?? "(unknown)";
  const ts = formatDateTime(event);
  const sev = event.severityText ?? "INFO";
  const lines: Line[] = [];

  lines.push({ k: "title", name, ts, sev });
  lines.push({ k: "sep" });

  const repo = attrs["vcs.repository.name"];
  const pr = attrs["vcs.pr.number"];
  const ref = attrs["vcs.ref.name"];
  const ticket = attrs["linear.issue.identifier"];
  const orchId = attrs["catalyst.orchestrator.id"];
  const worker = attrs["catalyst.worker.ticket"];
  const phase = attrs["catalyst.phase"];

  if (repo) lines.push({ k: "field", label: "repo", value: repo });
  if (pr) lines.push({ k: "field", label: "pr", value: `#${pr}`, color: "cyan" });
  if (ref) lines.push({ k: "field", label: "ref", value: ref });
  if (ticket) lines.push({ k: "field", label: "ticket", value: ticket, color: "yellow" });
  if (orchId) lines.push({ k: "field", label: "orchestrator", value: orchId });
  if (worker) lines.push({ k: "field", label: "worker", value: worker });
  if (phase !== undefined && phase !== null) {
    lines.push({ k: "field", label: "phase", value: String(phase) });
  }

  const conclusion = attrs["cicd.pipeline.run.conclusion"];
  const pipeline = attrs["cicd.pipeline.name"];
  if (conclusion || pipeline) {
    lines.push({ k: "sep" });
    if (pipeline) lines.push({ k: "field", label: "pipeline", value: pipeline });
    if (conclusion) {
      const c = conclusion === "success" ? "green" : conclusion === "failure" ? "red" : "yellow";
      lines.push({ k: "field", label: "conclusion", value: conclusion, color: c });
    }
  }

  lines.push({ k: "sep" });
  const svcName = event.resource?.["service.name"];
  const svcVer = event.resource?.["service.version"];
  if (svcName) {
    lines.push({ k: "field", label: "service", value: svcVer ? `${svcName}  v${svcVer}` : svcName });
  }
  // CTL-350: surface event.id (CTL-344 UUIDv4). The field is positioned above
  // trace/span because the per-event id is the primary key operators use to
  // correlate a HUD row with the underlying JSONL record.
  if (event.id) lines.push({ k: "field", label: "event-id", value: event.id });
  if (event.traceId) lines.push({ k: "field", label: "trace", value: event.traceId });
  if (event.spanId) lines.push({ k: "field", label: "span", value: event.spanId });

  const message = formatDetailBody(event);
  const payload = event.body?.payload;

  // CTL-350: promote source_events (wake-event triggering metadata) from the
  // generic JSON dump below to labeled rows. Receivers — both human operators
  // and downstream agents — get structured context including a copy-paste
  // lookup_jq query for retrieving the full triggering event.
  const sourceEvents =
    payload && typeof payload === "object" && "source_events" in payload
      ? (payload as Record<string, unknown>)["source_events"]
      : undefined;
  if (Array.isArray(sourceEvents) && sourceEvents.length > 0) {
    lines.push({ k: "sep" });
    sourceEvents.forEach((s, i) => {
      const sEvt = (s ?? {}) as Record<string, unknown>;
      const idx = sourceEvents.length > 1 ? ` [${i + 1}]` : "";
      if (typeof sEvt["name"] === "string" && sEvt["name"].length > 0) {
        lines.push({ k: "field", label: `source name${idx}`, value: String(sEvt["name"]) });
      }
      if (typeof sEvt["ticket"] === "string" && sEvt["ticket"].length > 0) {
        lines.push({ k: "field", label: `source ticket${idx}`, value: String(sEvt["ticket"]), color: "yellow" });
      }
      const pr = sEvt["pr"];
      if (typeof pr === "number" || (typeof pr === "string" && pr.length > 0)) {
        lines.push({ k: "field", label: `source pr${idx}`, value: `#${pr}`, color: "cyan" });
      }
      if (typeof sEvt["id"] === "string" && sEvt["id"].length > 0) {
        lines.push({ k: "field", label: `source id${idx}`, value: String(sEvt["id"]) });
      }
      if (typeof sEvt["lookup_jq"] === "string" && sEvt["lookup_jq"].length > 0) {
        lines.push({ k: "field", label: `lookup${idx}`, value: String(sEvt["lookup_jq"]) });
      }
    });
  }

  if (message) {
    lines.push({ k: "sep" });
    const maxW = cols - LABEL_W - 6;
    for (const para of message.split("\n")) {
      if (para.length === 0) {
        lines.push({ k: "text", value: "" });
        continue;
      }
      for (let i = 0; i < para.length; i += Math.max(1, maxW)) {
        lines.push({ k: "text", value: para.slice(i, i + maxW) });
      }
    }
  }
  if (payload && typeof payload === "object" && Object.keys(payload).length > 0) {
    if (!message) lines.push({ k: "sep" });
    for (const jl of JSON.stringify(payload, null, 2).split("\n")) {
      lines.push({ k: "text", value: jl, dim: true });
    }
  }

  lines.push({ k: "sep" });
  lines.push({ k: "hint" });
  return lines;
}

function renderLine(line: Line, i: number, cols: number): React.ReactNode {
  const maxW = cols - 4;
  switch (line.k) {
    case "sep":
      return <Text key={i} dimColor>{"  " + "─".repeat(Math.max(0, maxW))}</Text>;
    case "title": {
      const sevColor = (SEV_COLOR[line.sev] ?? "gray") as Parameters<typeof Text>[0]["color"];
      // Compute name width from actual ts/sev lengths so the timestamp never wraps.
      // sevText = "  <sev>" (2 leading spaces); +1 keeps a gap between name and ts.
      const sevText = `  ${line.sev}`;
      const budget = line.ts.length + sevText.length + 1;
      const nameW = Math.max(0, maxW - budget);
      const name = line.name.length > nameW
        ? line.name.slice(0, Math.max(0, nameW - 1)) + "…"
        : line.name.padEnd(nameW);
      return (
        <Box key={i} flexDirection="row" paddingX={1}>
          <Text bold color="white">{name}</Text>
          <Text color="cyan">{line.ts}</Text>
          <Text color={sevColor}>{sevText}</Text>
        </Box>
      );
    }
    case "field": {
      const valColor = (line.color ?? "white") as Parameters<typeof Text>[0]["color"];
      const valW = Math.max(0, maxW - LABEL_W - 2);
      return (
        <Box key={i} flexDirection="row" paddingX={1}>
          <Text dimColor>{line.label.padEnd(LABEL_W)}</Text>
          <Text color={valColor}>{String(line.value).slice(0, valW)}</Text>
        </Box>
      );
    }
    case "text":
      return (
        <Box key={i} paddingX={1}>
          <Text dimColor={line.dim ?? false} color={line.dim ? undefined : ("white" as const)}>
            {String(line.value).slice(0, maxW)}
          </Text>
        </Box>
      );
    case "hint":
      return <Text key={i} dimColor>{"  j/k scroll  ·  Enter to close"}</Text>;
  }
}

export function DetailPane({ event, scrollTop, maxHeight }: DetailPaneProps) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const lines = buildDetailLines(event, cols);

  // First line is always the title — pin it so it stays visible while scrolling.
  const titleLine = lines[0];
  const scrollable = lines.slice(1);
  const totalScrollable = scrollable.length;
  const canUp = scrollTop > 0;
  const canDown = scrollTop + maxHeight < totalScrollable;
  const visible = scrollable.slice(scrollTop, scrollTop + maxHeight);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray">
      {titleLine && renderLine(titleLine, -1, cols)}
      {visible.map((line, i) => renderLine(line, i, cols))}
      {(canUp || canDown) && (
        <Text dimColor>
          {`  ${canUp ? "↑" : " "} ${scrollTop + 1}–${Math.min(scrollTop + maxHeight, totalScrollable)}/${totalScrollable} ${canDown ? "↓" : " "}`}
        </Text>
      )}
    </Box>
  );
}
