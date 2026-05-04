import { cn } from "@/lib/utils";

/**
 * Topic palette: a sidebar of well-known event-topic prefixes the user can
 * toggle. Each toggle on/off rewrites the jq predicate the activity stream
 * subscribes with.
 *
 * Prefixes ending in `.` match `startswith(...)` (covers v2 events like
 * `github.pr.merged`). Bare names (no trailing dot) match the exact name OR
 * `name-...` which covers v1 unprefixed bash topics like `worker-done`,
 * `wave-started`, `session-started`.
 */
export interface TopicGroup {
  label: string;
  description: string;
  /** Each entry is one toggleable chip. */
  prefixes: string[];
}

export const TOPIC_GROUPS: TopicGroup[] = [
  {
    label: "GitHub PRs",
    description: "Pull request lifecycle",
    prefixes: ["github.pr."],
  },
  {
    label: "GitHub CI",
    description: "Check suites + status checks",
    prefixes: ["github.check_suite.", "github.status."],
  },
  {
    label: "GitHub Deploy",
    description: "Deployments and deploy statuses",
    prefixes: ["github.deployment.", "github.deployment_status."],
  },
  {
    label: "GitHub Push",
    description: "Branch pushes",
    prefixes: ["github.push"],
  },
  {
    label: "GitHub Reviews + Comments",
    description: "Reviews, threads, and comments",
    prefixes: [
      "github.pr_review.",
      "github.pr_review_thread.",
      "github.pr_review_comment.",
      "github.issue_comment.",
    ],
  },
  {
    label: "Linear",
    description: "Issues, comments, cycles",
    prefixes: ["linear."],
  },
  {
    label: "Comms",
    description: "Inter-agent messages",
    prefixes: ["comms."],
  },
  {
    label: "Catalyst Sessions",
    description: "Per-session lifecycle events",
    prefixes: ["session-", "phase-", "pr-opened", "heartbeat"],
  },
  {
    label: "Catalyst Orchestrator",
    description: "Orchestrator + worker + wave events",
    prefixes: [
      "orchestrator-",
      "worker-",
      "wave-",
      "verification-",
      "attention-",
      "archive",
    ],
  },
];

interface Props {
  active: ReadonlySet<string>;
  onToggle: (prefix: string) => void;
  onClear: () => void;
}

export function ActivityTopicPalette({ active, onToggle, onClear }: Props) {
  return (
    <div className="w-64 shrink-0 overflow-y-auto rounded bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Topics
        </h3>
        {active.size > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] text-muted hover:text-fg"
          >
            clear
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {TOPIC_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="mb-1 px-1 text-[11px] font-medium text-fg">
              {g.label}
            </div>
            <div className="flex flex-wrap gap-1">
              {g.prefixes.map((p) => {
                const on = active.has(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onToggle(p)}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                      on
                        ? "bg-accent/20 text-accent"
                        : "bg-surface-3 text-muted hover:text-fg",
                    )}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
