/**
 * Worker task-list reader.
 *
 * Plumbing chain:
 *   worker pid
 *     → ~/.claude/sessions/{pid}.json    (JSON with `sessionId`)
 *       → ~/.claude/tasks/{sessionId}/   (directory of *.json task files)
 *
 * A worker's task list is only discoverable when both the session file AND the
 * tasks directory exist. If either is missing, callers see `null` — this is
 * indistinguishable from "the worker never wrote tasks" without a diagnostic
 * probe, hence {@link getTaskDiagnostic}.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface WorkerTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks?: string[];
  blockedBy?: string[];
  owner?: string;
}

interface WorkerTaskList {
  sessionId: string;
  tasks: WorkerTask[];
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

const CLAUDE_TASKS_DIR = join(homedir(), ".claude", "tasks");

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x: unknown) => typeof x === "string")
    ? v
    : undefined;
}

/**
 * Look up a session ID from a PID via ~/.claude/sessions/{pid}.json
 */
export function sessionIdFromPid(pid: number): string | null {
  const sessionFile = join(homedir(), ".claude", "sessions", `${pid}.json`);
  try {
    if (!existsSync(sessionFile)) return null;
    const data: unknown = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (!isRecord(data)) return null;
    return asString(data.sessionId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Read task list for a given session ID from ~/.claude/tasks/{sessionId}/
 */
export function readWorkerTasks(sessionId: string): WorkerTaskList | null {
  const taskDir = join(CLAUDE_TASKS_DIR, sessionId);
  if (!existsSync(taskDir)) return null;

  const tasks: WorkerTask[] = [];

  try {
    const files = readdirSync(taskDir).filter(
      (f) => f.endsWith(".json") && f !== ".lock",
    );

    for (const file of files) {
      try {
        const raw = readFileSync(join(taskDir, file), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) continue;

        const id = asString(parsed.id);
        const subject = asString(parsed.subject);
        if (!id || !subject) continue;

        const status = asString(parsed.status);
        tasks.push({
          id,
          subject,
          description: asString(parsed.description),
          activeForm: asString(parsed.activeForm),
          status:
            status === "in_progress" || status === "completed"
              ? status
              : "pending",
          blocks: asStringArray(parsed.blocks),
          blockedBy: asStringArray(parsed.blockedBy),
          owner: asString(parsed.owner),
        });
      } catch {
        // skip malformed task files
      }
    }
  } catch {
    return null;
  }

  if (tasks.length === 0) return null;

  // Sort by id (numeric string)
  tasks.sort((a, b) => Number(a.id) - Number(b.id));

  return {
    sessionId,
    tasks,
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
  };
}

export interface TaskDiagnostic {
  pid: number | null;
  sessionId: string | null;
  expectedPath: string | null;
  pathExists: boolean;
  fileCount: number;
}

/**
 * Diagnostic probe for the task-file plumbing. Given a pid and/or sessionId,
 * returns the resolved sessionId, the expected task directory, whether it
 * exists, and the count of task files present.
 *
 * Used by `/api/worker-tasks/debug` to answer "why is the task list empty
 * for this worker?" without requiring ad-hoc fs inspection.
 *
 * @param opts.pid - worker pid; used to resolve sessionId if sessionId omitted.
 * @param opts.sessionId - explicit sessionId (skips pid lookup).
 * @param opts.tasksRoot - override for the tasks root (defaults to `~/.claude/tasks`);
 *   exposed for testing.
 */
export function getTaskDiagnostic(opts: {
  pid?: number;
  sessionId?: string;
  tasksRoot?: string;
}): TaskDiagnostic {
  const tasksRoot = opts.tasksRoot ?? CLAUDE_TASKS_DIR;
  const pid = typeof opts.pid === "number" ? opts.pid : null;
  const sessionId =
    opts.sessionId ?? (pid !== null ? sessionIdFromPid(pid) : null);

  if (!sessionId) {
    return {
      pid,
      sessionId: null,
      expectedPath: null,
      pathExists: false,
      fileCount: 0,
    };
  }

  const expectedPath = join(tasksRoot, sessionId);
  const pathExists = existsSync(expectedPath);
  let fileCount = 0;
  if (pathExists) {
    try {
      fileCount = readdirSync(expectedPath).filter(
        (f) => f.endsWith(".json") && f !== ".lock",
      ).length;
    } catch {
      fileCount = 0;
    }
  }

  return { pid, sessionId, expectedPath, pathExists, fileCount };
}
