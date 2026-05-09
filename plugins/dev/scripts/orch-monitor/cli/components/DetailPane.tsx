import { Box, Text, useStdout } from "ink";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

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
  const d = new Date(event.ts);
  const ts = d.toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
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
  if (event.traceId) lines.push({ k: "field", label: "trace", value: event.traceId });
  if (event.spanId) lines.push({ k: "field", label: "span", value: event.spanId });

  const message = event.body?.message;
  const payload = event.body?.payload;
  if (message) {
    lines.push({ k: "sep" });
    const maxW = cols - LABEL_W - 6;
    for (let i = 0; i < message.length; i += Math.max(1, maxW)) {
      lines.push({ k: "text", value: message.slice(i, i + maxW) });
    }
  }
  if (payload && typeof payload === "object" && Object.keys(payload as object).length > 0) {
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
      const nameW = Math.max(0, maxW - 14);
      return (
        <Box key={i} flexDirection="row" paddingX={1}>
          <Text bold color="white">{line.name.slice(0, nameW).padEnd(nameW)}</Text>
          <Text color="cyan">{line.ts}</Text>
          <Text color={sevColor}>{`  ${line.sev}`}</Text>
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
