import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

const ORCH_ID = "orch-subagent";
const WORKER_WITH_STREAM = "CTL-100";
const WORKER_NO_STREAM = "CTL-200";

function writeStreamLines(path: string, lines: unknown[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subagent-endpoints-test-"));
  const wtDir = join(tmpDir, "wt");
  const orchDir = join(wtDir, ORCH_ID);
  mkdirSync(join(orchDir, "workers"), { recursive: true });

  writeFileSync(
    join(orchDir, "state.json"),
    JSON.stringify({
      id: ORCH_ID,
      startedAt: new Date().toISOString(),
      currentWave: 1,
      totalWaves: 1,
      waves: [{ wave: 1, status: "in_progress", tickets: [WORKER_WITH_STREAM, WORKER_NO_STREAM] }],
    }),
  );

  // Worker 1: has a signal file + a stream with TodoWrite + nested Agent subagent.
  const mkSignal = (ticket: string): string =>
    JSON.stringify({
      ticket,
      orchestrator: ORCH_ID,
      workerName: `${ORCH_ID}-${ticket}`,
      status: "in_progress",
      phase: 3,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    });
  writeFileSync(join(orchDir, "workers", `${WORKER_WITH_STREAM}.json`), mkSignal(WORKER_WITH_STREAM));
  writeFileSync(join(orchDir, "workers", `${WORKER_NO_STREAM}.json`), mkSignal(WORKER_NO_STREAM));

  writeStreamLines(join(orchDir, "workers", `${WORKER_WITH_STREAM}-stream.jsonl`), [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_w1_tw",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "worker-task-1", activeForm: "Doing 1", status: "in_progress" },
                { content: "worker-task-2", status: "pending" },
              ],
            },
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: "sess-A",
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_w1_spawn",
            name: "Agent",
            input: {
              description: "research codebase",
              subagent_type: "catalyst-dev:codebase-locator",
              prompt: "find",
            },
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: "sess-A",
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_w1_subtw",
            name: "TodoWrite",
            input: { todos: [{ content: "sub-task-1", status: "completed" }] },
          },
        ],
      },
      parent_tool_use_id: "toolu_w1_spawn",
      session_id: "sess-A",
    },
  ]);

  // Worker 2 has no stream file at all — endpoints should still return empty.

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

interface SubagentTreeResp {
  orchId: string;
  ticket: string;
  tree: {
    toolUseId: string | null;
    todos: Array<{ content: string; status: string }>;
    children: Array<{
      toolUseId: string;
      description: string;
      todos: Array<{ content: string; status: string }>;
    }>;
  };
}

interface WorkerTodosResp {
  orchId: string;
  ticket: string;
  todos: Array<{ content: string; status: string; ticket: string; ownerPath: string[] }>;
}

interface OrchTodosResp {
  orchId: string;
  todos: Array<{ content: string; status: string; ticket: string; ownerPath: string[] }>;
}

describe("GET /api/worker/:orchId/:ticket/subagents", () => {
  it("returns the full tree with root todos and nested subagents", async () => {
    const res = await fetch(
      `${baseUrl}/api/worker/${ORCH_ID}/${WORKER_WITH_STREAM}/subagents`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as SubagentTreeResp;
    expect(body.orchId).toBe(ORCH_ID);
    expect(body.ticket).toBe(WORKER_WITH_STREAM);
    expect(body.tree.toolUseId).toBeNull();
    expect(body.tree.todos).toHaveLength(2);
    expect(body.tree.children).toHaveLength(1);
    expect(body.tree.children[0].description).toBe("research codebase");
    expect(body.tree.children[0].todos).toEqual([
      { content: "sub-task-1", status: "completed" },
    ]);
  });

  it("returns 200 with an empty tree when the worker has no stream file", async () => {
    const res = await fetch(
      `${baseUrl}/api/worker/${ORCH_ID}/${WORKER_NO_STREAM}/subagents`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SubagentTreeResp;
    expect(body.tree.toolUseId).toBeNull();
    expect(body.tree.todos).toEqual([]);
    expect(body.tree.children).toEqual([]);
  });

  it("404s on an unknown orchestrator id", async () => {
    const res = await fetch(
      `${baseUrl}/api/worker/orch-missing/${WORKER_WITH_STREAM}/subagents`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects orchIds containing '..'", async () => {
    // Embedded '..' (not as a standalone path segment) survives URL
    // normalization and hits the defense-in-depth guard.
    const res = await fetch(
      `${baseUrl}/api/worker/orch..evil/${WORKER_WITH_STREAM}/subagents`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects tickets containing '..'", async () => {
    const res = await fetch(
      `${baseUrl}/api/worker/${ORCH_ID}/CTL..100/subagents`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/worker/:orchId/:ticket/todos", () => {
  it("flattens todos across worker + subagents with ticket stamp", async () => {
    const res = await fetch(
      `${baseUrl}/api/worker/${ORCH_ID}/${WORKER_WITH_STREAM}/todos`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerTodosResp;
    expect(body.ticket).toBe(WORKER_WITH_STREAM);
    expect(body.todos).toHaveLength(3);
    for (const todo of body.todos) {
      expect(todo.ticket).toBe(WORKER_WITH_STREAM);
    }
    const rootTodos = body.todos.filter((t) => t.ownerPath.length === 0);
    const nestedTodos = body.todos.filter((t) => t.ownerPath.length > 0);
    expect(rootTodos).toHaveLength(2);
    expect(nestedTodos).toHaveLength(1);
    expect(nestedTodos[0].ownerPath).toEqual(["research codebase"]);
    expect(nestedTodos[0].content).toBe("sub-task-1");
  });

  it("returns empty todos when the stream file is missing", async () => {
    const res = await fetch(
      `${baseUrl}/api/worker/${ORCH_ID}/${WORKER_NO_STREAM}/todos`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkerTodosResp;
    expect(body.todos).toEqual([]);
  });

  it("404s on unknown orchestrator", async () => {
    const res = await fetch(`${baseUrl}/api/worker/orch-missing/X/todos`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/orch/:id/todos", () => {
  it("returns todos across all workers in the orchestrator", async () => {
    const res = await fetch(`${baseUrl}/api/orch/${ORCH_ID}/todos`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrchTodosResp;
    expect(body.orchId).toBe(ORCH_ID);
    // WORKER_WITH_STREAM has 3 todos; WORKER_NO_STREAM has 0.
    expect(body.todos).toHaveLength(3);
    const tickets = new Set(body.todos.map((t) => t.ticket));
    expect(tickets.has(WORKER_WITH_STREAM)).toBe(true);
    expect(tickets.has(WORKER_NO_STREAM)).toBe(false);
  });

  it("404s on unknown orchestrator", async () => {
    const res = await fetch(`${baseUrl}/api/orch/orch-missing/todos`);
    expect(res.status).toBe(404);
  });

  it("rejects orchIds containing '..'", async () => {
    const res = await fetch(`${baseUrl}/api/orch/orch..evil/todos`);
    expect(res.status).toBe(400);
  });
});
