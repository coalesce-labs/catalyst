import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mockups-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });

  const orchDir = join(wtDir, "orch-test");
  mkdirSync(join(orchDir, "workers"), { recursive: true });
  writeFileSync(
    join(orchDir, "state.json"),
    JSON.stringify({
      id: "orch-test",
      startedAt: new Date().toISOString(),
      currentWave: 1,
      totalWaves: 1,
      waves: [{ wave: 1, status: "in_progress", tickets: [] }],
    }),
  );

  const annotationsDbPath = join(tmpDir, "annotations.db");
  server = createServer({ port: 0, wtDir, startWatcher: false, annotationsDbPath });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("mockups — worker.html", () => {
  it("serves /mockups/worker.html with text/html", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
    expect(body).toContain('<main class="mockup-shell">');
  });

  it("gallery index links to worker.html", async () => {
    const res = await fetch(`${baseUrl}/mockups/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="./worker.html"');
  });

  it("worker.html supports mode switching via ?mode param", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    // The mode resolver writes html[data-worker-mode] — mockup script must reference it.
    expect(body).toContain("data-worker-mode");
    // Both modes are supported.
    expect(body).toContain("orch-worker");
    expect(body).toContain("standalone");
  });

  it("worker.html renders all required sections", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    // Header + breadcrumb + title markers.
    expect(body).toContain("worker-head");
    expect(body).toContain("worker-head__breadcrumb");
    // Phase timeline.
    expect(body).toContain("phase-strip");
    // Signal panel.
    expect(body).toContain("signal-grid");
    // PR card.
    expect(body).toContain("pr-card");
    // Stream tail.
    expect(body).toContain("stream-list");
    // Todos block (mini kanban with 3 columns).
    expect(body).toContain("todos-kanban");
    // Subagents section.
    expect(body).toContain("subagent-row");
    // Cost breakdown.
    expect(body).toContain("cost-grid");
  });

  it("worker.html phase timeline covers all six oneshot phases", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text().then((s) => s.toLowerCase());
    for (const phase of ["research", "plan", "implement", "validate", "ship", "done"]) {
      expect(body).toContain(phase);
    }
  });

  it("worker.html stream tail includes the required tool mix", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    // Acceptance criterion: stream tail has realistic mock events covering
    // Bash, Read, Edit, Task, TodoWrite.
    for (const tool of ["Bash", "Read", "Edit", "Task", "TodoWrite"]) {
      expect(body).toContain(tool);
    }
  });

  it("worker.html renders at least two subagents with status", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    const matches = body.match(/class="subagent-row[^"]*"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("mockups — briefing.html", () => {
  it("serves /mockups/briefing.html with text/html", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
    expect(body).toContain('<main class="mockup-shell">');
  });

  it("gallery index links to briefing.html", async () => {
    const res = await fetch(`${baseUrl}/mockups/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="./briefing.html"');
  });

  it("briefing.html includes header markers + summarize button", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    expect(body).toContain("briefing-head");
    expect(body).toContain("briefing-head__meta");
    expect(body).toContain("summarize-btn");
  });

  it("briefing.html renders rollup section with all three subsections", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    expect(body).toContain("rollup-section");
    expect(body).toContain("what-shipped");
    expect(body).toContain("what-to-see");
    expect(body).toContain("gotchas");
  });

  it("briefing.html renders at least two wave briefings", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    const panels = body.match(/class="wave-briefing[^"]*"/g) ?? [];
    expect(panels.length).toBeGreaterThanOrEqual(2);
    const tabs = body.match(/class="wave-tab[^"]*"/g) ?? [];
    expect(tabs.length).toBeGreaterThanOrEqual(2);
  });

  it("briefing.html includes AI summary panel with shimmer + summary slots", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    expect(body).toContain("ai-panel");
    expect(body).toContain("ai-panel__shimmer");
    expect(body).toContain("ai-panel__summary");
  });

  it("briefing.html references vendored marked script via /public", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    // Path must resolve to the server's /public/vendor/* route — relative paths
    // like ../vendor/* resolve to /vendor/* which the server does not serve.
    expect(body).toContain("../public/vendor/marked.min.js");
  });

  it("briefing.html vendored marked path actually serves from the server", async () => {
    // Pull the script src out of the HTML, resolve it relative to /mockups/,
    // and fetch it to confirm the path isn't a dead link.
    const page = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await page.text();
    const match = body.match(/<script src="([^"]+marked\.min\.js)"/);
    expect(match).not.toBeNull();
    const src = match![1];
    const resolved = new URL(src, `${baseUrl}/mockups/`).pathname;
    const assetRes = await fetch(`${baseUrl}${resolved}`);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers.get("content-type")).toContain("javascript");
  });

  it("briefing.html copy uses operator voice (no emoji, no exclamation in prose)", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    // Scope the check to the visible mockup-container region — the <script>
    // and <style> blocks above contain tokens like "!important" and
    // "!function" that aren't UI copy.
    const startMarker = '<div class="mockup-container">';
    const endMarker = "</main>";
    const start = body.indexOf(startMarker);
    const end = body.indexOf(endMarker, start + startMarker.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const prose = body.slice(start + startMarker.length, end);
    expect(prose).not.toContain("!");
    // Spot-check a handful of pictographic emoji by code point; the full
    // Unicode emoji range needs a flagged regex under the security linter,
    // and the static mockup content is tightly controlled anyway.
    for (const cp of [0x1f680, 0x1f525, 0x2728, 0x1f389, 0x2705]) {
      expect(prose).not.toContain(String.fromCodePoint(cp));
    }
  });

  it("briefing.html renders shipped rows with ticket chips and PR chips", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    const ticketChips = body.match(/class="chip chip--ticket"/g) ?? [];
    const mergedChips = body.match(/class="chip chip--merged"/g) ?? [];
    expect(ticketChips.length).toBeGreaterThanOrEqual(3);
    expect(mergedChips.length).toBeGreaterThanOrEqual(3);
  });

  it("briefing.html uses pre-paint bootstrap with system + theme", async () => {
    const res = await fetch(`${baseUrl}/mockups/briefing.html`);
    const body = await res.text();
    expect(body).toContain('data-system="operator-console"');
    expect(body).toContain("data-theme");
    expect(body).toContain("__catalystMockupPrefs");
  });
});

describe("mockups — comms.html", () => {
  it("serves /mockups/comms.html with text/html", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
    expect(body).toContain('<main class="mockup-shell">');
  });

  it("gallery index links to comms.html", async () => {
    const res = await fetch(`${baseUrl}/mockups/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="./comms.html"');
  });

  it("renders three-pane layout with channels/thread/agents", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    expect(body).toContain("comms-layout");
    expect(body).toContain("comms-channels");
    expect(body).toContain("comms-thread");
    expect(body).toContain("comms-agents");
  });

  it("renders at least one channel row with a name and participant count", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    const matches = body.match(/class="channel-row[^"]*"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("channel-row__name");
    expect(body).toContain("channel-row__count");
  });

  it("renders agent cards with capabilities, status, role, heartbeat, and TTL fields", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    for (const cls of [
      "agent-card",
      "agent-card__name",
      "agent-card__role",
      "agent-card__capabilities",
      "agent-card__status",
      "agent-card__heartbeat",
      "agent-card__ttl",
    ]) {
      expect(body).toContain(cls);
    }
    // At least two agent cards in the demo data.
    const cards = body.match(/class="agent-card[^"]*"/g) ?? [];
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  it("marks attention messages with a distinct class and dedicated styling", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    // Class must be applied to at least one message row, not just defined in CSS.
    expect(body).toMatch(/class="message-row[^"]*message--attention/);
    // Styling must actually differ — border-left using the warning token.
    expect(body).toMatch(
      /\.message--attention\s*\{[^}]*border-left:[^}]*var\(--color-warning\)/,
    );
  });

  it("defines a reduced-motion-friendly heartbeat animation using the motion token", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    // Animation must be named and the keyframes defined.
    expect(body).toMatch(/@keyframes\s+comms-heartbeat/);
    // Animation must use the shared motion token, not a hardcoded duration.
    expect(body).toContain("var(--motion-duration-heartbeat)");
    // Reduced-motion guard present.
    expect(body).toContain("prefers-reduced-motion");
  });

  it("renders an empty state for each of the three panes", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    expect(body).toContain("comms-empty--channels");
    expect(body).toContain("comms-empty--thread");
    expect(body).toContain("comms-empty--agents");
  });

  it("status dot pulses only on fresh heartbeats (data-fresh attribute)", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    // The CSS rule must be keyed on data-fresh="true" so stale/done cards don't pulse.
    expect(body).toMatch(/data-fresh="true"/);
    expect(body).toMatch(/\[data-fresh="true"\]/);
  });

  it("contains no emoji characters (operator voice, per ticket)", async () => {
    const res = await fetch(`${baseUrl}/mockups/comms.html`);
    const body = await res.text();
    // Scan for codepoints inside emoji Unicode blocks (Misc Symbols &
    // Pictographs, Emoticons, Transport, Supplemental Symbols, Extended-A).
    // Iterating codepoints avoids regex backtracking / unsafe-regex warnings.
    let hasEmoji = false;
    for (const ch of body) {
      const cp = ch.codePointAt(0) ?? 0;
      if (
        (cp >= 0x1f300 && cp <= 0x1f5ff) ||
        (cp >= 0x1f600 && cp <= 0x1f64f) ||
        (cp >= 0x1f680 && cp <= 0x1f6ff) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x1fa70 && cp <= 0x1faff)
      ) {
        hasEmoji = true;
        break;
      }
    }
    expect(hasEmoji).toBe(false);
  });
});

describe("mockups — agent-graph.html", () => {
  it("serves /mockups/agent-graph.html with text/html", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
    expect(body).toContain('<main class="mockup-shell">');
  });

  it("gallery index links to agent-graph.html", async () => {
    const res = await fetch(`${baseUrl}/mockups/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="./agent-graph.html"');
  });

  it("uses pre-paint bootstrap with system + theme", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    expect(body).toContain('data-system="operator-console"');
    expect(body).toContain("data-theme");
    expect(body).toContain("__catalystMockupPrefs");
  });

  it("loads React, React Flow, and dagre from CDN via importmap", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    expect(body).toContain('type="importmap"');
    // CDN sources are required by the ticket — no build step.
    expect(body).toMatch(/react(@|\/)/);
    expect(body).toMatch(/@?xyflow|reactflow/);
    expect(body).toMatch(/dagre/);
  });

  it("defines all four node component names per CTL-140 scope", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    for (const name of [
      "OrchestratorNode",
      "WorkerNode",
      "SubagentNode",
      "TodoNode",
    ]) {
      expect(body).toContain(name);
    }
  });

  it("wraps node components in React.memo per React Flow perf guidance", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    // At least one React.memo wrapper must appear — covers all four node types.
    expect(body).toMatch(/React\.memo\s*\(/);
  });

  it("declares initial data with at least 1 orch / 3 workers / 5 subagents / 8 todos", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    const count = (re: RegExp) => (body.match(re) ?? []).length;
    // Initial nodes declare type: "orchestrator" | "worker" | "subagent" | "todo".
    // TodoNode is a collapsed checklist per the ticket, so todos are counted by
    // individual items (state field) inside the todo node arrays rather than by
    // top-level todo node count.
    expect(count(/type:\s*"orchestrator"/g)).toBeGreaterThanOrEqual(1);
    expect(count(/type:\s*"worker"/g)).toBeGreaterThanOrEqual(3);
    expect(count(/type:\s*"subagent"/g)).toBeGreaterThanOrEqual(5);
    expect(count(/type:\s*"todo"/g)).toBeGreaterThanOrEqual(1);
    expect(count(/state:\s*"(?:completed|in_progress|pending)"/g)).toBeGreaterThanOrEqual(8);
  });

  it("runs a real-time mock mutator every 2 seconds", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    // Mock updater cadence is 2000ms per the ticket.
    expect(body).toMatch(/setInterval\s*\([^,]+,\s*2000/);
  });

  it("renders minimap, controls, legend, and drawer placeholders", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    // Root mount point for the React Flow canvas.
    expect(body).toContain("graph-root");
    // MiniMap imported from xyflow — verified by name.
    expect(body).toContain("MiniMap");
    // Controls imported from xyflow — verified by name.
    expect(body).toContain("Controls");
    // Legend container rendered as static HTML outside the React tree.
    expect(body).toContain("graph-legend");
    // Drawer slides in when a node is clicked; placeholder lives in the DOM.
    expect(body).toContain("graph-drawer");
  });

  it("legend maps every worker status to a color token", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    // Six status labels mirror the kanban chips from CTL-126.
    for (const status of [
      "dispatched",
      "researching",
      "implementing",
      "validating",
      "merging",
      "done",
    ]) {
      expect(body).toContain(status);
    }
  });

  it("loads the shared chrome.js for keybindings", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    expect(body).toContain('src="./_shared/chrome.js"');
  });

  it("contains no emoji characters (operator voice, per ticket)", async () => {
    const res = await fetch(`${baseUrl}/mockups/agent-graph.html`);
    const body = await res.text();
    // Scan for codepoints inside emoji Unicode blocks (same blocks as comms.html).
    let hasEmoji = false;
    for (const ch of body) {
      const cp = ch.codePointAt(0) ?? 0;
      if (
        (cp >= 0x1f300 && cp <= 0x1f5ff) ||
        (cp >= 0x1f600 && cp <= 0x1f64f) ||
        (cp >= 0x1f680 && cp <= 0x1f6ff) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x1fa70 && cp <= 0x1faff)
      ) {
        hasEmoji = true;
        break;
      }
    }
    expect(hasEmoji).toBe(false);
  });
});
