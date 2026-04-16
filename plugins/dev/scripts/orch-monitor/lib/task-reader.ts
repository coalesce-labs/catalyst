import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface WorkerTask {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks?: string[];
  blockedBy?: string[];
  owner?: string;
}

export interface WorkerTaskList {
  sessionId: string;
  tasks: WorkerTask[];
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

const CLAUDE_TASKS_DIR = join(homedir(), ".claude", "tasks");

/**
 * Look up a session ID from a PID via ~/.claude/sessions/{pid}.json
 */
export function sessionIdFromPid(pid: number): string | null {
  const sessionFile = join(homedir(), ".claude", "sessions", `${pid}.json`);
  try {
    if (!existsSync(sessionFile)) return null;
    const data = JSON.parse(readFileSync(sessionFile, "utf8"));
    return data.sessionId ?? null;
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
        const task = JSON.parse(raw);
        if (task && typeof task.id === "string" && typeof task.subject === "string") {
          tasks.push({
            id: task.id,
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
            status: task.status ?? "pending",
            blocks: task.blocks,
            blockedBy: task.blockedBy,
            owner: task.owner,
          });
        }
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
