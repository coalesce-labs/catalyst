// project-setup.ts — CTL-1154: ensure a project's server-side setup (Linear
// state contract + registry upsert) by driving setup-execution-core-states.sh,
// and map its exit codes into a typed ValidationReport for the API + UI. The
// script runner is injectable (tests pass a fake; production spawns the real
// script with a timeout) so the handler is never load-bearing on a hung
// subprocess (learning: audit-proxy-must-not-be-load-bearing).
//
// Exit codes from setup-execution-core-states.sh:
//   0 — ok
//   1 — prereq missing (jq/curl/LINEAR_API_KEY)
//   2 — Linear API error
//   3 — states partially created
//   4 — registry upsert failed
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

export type StepStatus = "ok" | "failed" | "skipped";

export interface ValidationStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface ValidationReport {
  ready: boolean;
  exitCode: number | null;
  steps: ValidationStep[];
}

export interface ProjectSetupRunResult {
  exitCode: number;
  stdout: string;
}

export type ProjectSetupRunner = (
  args: string[]
) => Promise<ProjectSetupRunResult>;

export interface RunProjectSetupOpts {
  configPath: string;
  key: string;
  vcsRepo: string;
  repoRoot: string;
  eligibleQuery?: unknown;
  runner?: ProjectSetupRunner;
  scriptPath?: string;
  timeoutMs?: number;
}

function resolveScriptPath(): string {
  // From orch-monitor/lib/, the setup script is two levels up at
  // plugins/dev/scripts/setup-execution-core-states.sh.
  const dir =
    typeof import.meta.dir === "string"
      ? import.meta.dir
      : fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(dir, "..", "..", "setup-execution-core-states.sh"),
    join(dir, "..", "setup-execution-core-states.sh"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]; // fallback; spawn will error descriptively
}

function defaultSetupRunner(timeoutMs = 120_000): ProjectSetupRunner {
  return async (args: string[]): Promise<ProjectSetupRunResult> => {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeoutHandle = setTimeout(() => {
      proc.kill();
    }, timeoutMs);
    try {
      const chunks: Uint8Array[] = [];
      const reader = proc.stdout;
      for await (const chunk of reader) {
        chunks.push(chunk as Uint8Array);
      }
      const stdout = Buffer.concat(chunks).toString("utf8");
      const exitCode = await proc.exited;
      return { exitCode: exitCode ?? 1, stdout };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

// Pure mapper: exit code + stdout → ValidationReport steps.
// Kept as a standalone function so it is testable in isolation.
export function mapExitToReport(
  exitCode: number,
  _stdout: string,
  priorSteps: ValidationStep[]
): ValidationReport {
  const steps = [...priorSteps];
  switch (exitCode) {
    case 0:
      steps.push(
        { id: "prereq", label: "Prerequisites satisfied", status: "ok" },
        { id: "api", label: "Linear API reachable", status: "ok" },
        { id: "states", label: "Linear state contract", status: "ok" },
        { id: "registry", label: "Registry entry upserted", status: "ok" }
      );
      return { ready: true, exitCode, steps };
    case 1:
      steps.push({
        id: "prereq",
        label: "Prerequisites satisfied",
        status: "failed",
        detail:
          "A prerequisite is missing — check that LINEAR_API_KEY (or token file) is set and that jq/curl are on PATH.",
      });
      return { ready: false, exitCode, steps };
    case 2:
      steps.push(
        { id: "prereq", label: "Prerequisites satisfied", status: "ok" },
        {
          id: "api",
          label: "Linear API reachable",
          status: "failed",
          detail: "Linear API returned an error during state creation.",
        }
      );
      return { ready: false, exitCode, steps };
    case 3:
      steps.push(
        { id: "prereq", label: "Prerequisites satisfied", status: "ok" },
        { id: "api", label: "Linear API reachable", status: "ok" },
        {
          id: "states",
          label: "Linear state contract",
          status: "failed",
          detail:
            "One or more required Linear states could not be created. Check API permissions.",
        },
        { id: "registry", label: "Registry entry upserted", status: "skipped" }
      );
      return { ready: false, exitCode, steps };
    case 4:
      steps.push(
        { id: "prereq", label: "Prerequisites satisfied", status: "ok" },
        { id: "api", label: "Linear API reachable", status: "ok" },
        { id: "states", label: "Linear state contract", status: "ok" },
        {
          id: "registry",
          label: "Registry entry upserted",
          status: "failed",
          detail: "Registry upsert failed — check disk permissions on ~/catalyst/execution-core/.",
        }
      );
      return { ready: false, exitCode, steps };
    default:
      steps.push({
        id: "setup",
        label: "Setup script ran",
        status: "failed",
        detail: `Setup script exited with unexpected code ${exitCode}.`,
      });
      return { ready: false, exitCode, steps };
  }
}

export async function runProjectSetup(
  opts: RunProjectSetupOpts
): Promise<ValidationReport> {
  const steps: ValidationStep[] = [];

  // Pre-flight: verify repoRoot exists before ever invoking the script.
  if (!opts.repoRoot || !existsSync(opts.repoRoot)) {
    steps.push({
      id: "repoRoot",
      label: "Repository path reachable",
      status: "failed",
      detail: `repoRoot not found on disk: ${opts.repoRoot}`,
    });
    return { ready: false, exitCode: null, steps };
  }
  steps.push({
    id: "repoRoot",
    label: "Repository path reachable",
    status: "ok",
  });

  const runner = opts.runner ?? defaultSetupRunner(opts.timeoutMs);
  const scriptPath = opts.scriptPath ?? resolveScriptPath();

  let res: ProjectSetupRunResult;
  try {
    res = await runner([scriptPath, "--config", opts.configPath, "--json"]);
  } catch (err) {
    steps.push({
      id: "setup",
      label: "Setup script ran",
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ready: false, exitCode: null, steps };
  }

  return mapExitToReport(res.exitCode, res.stdout, steps);
}
