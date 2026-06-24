// derivations-rail.tsx — CTL-1103 Phase 4: per-rule entity list + derivation trees.
// Shown when the operator selects a firing rule. Each entity expands to a
// /api/beliefs/why trace rendered via <DerivationTree/>.
import { useEffect, useState } from "react";
import { DerivationTree } from "@/components/governance/derivation-tree";
import { type TraceResult, isTraceResult, emptyTrace } from "@/lib/why-model";
import { subjectToTicket } from "./derivations-rail-model";
import { ChevronRight, ChevronDown } from "lucide-react";

interface EntityRowProps {
  subject: string;
  onOpenSource?: (ruleId: string) => void;
}

// CTL-1103 remediate: an explicit, discriminated row state. Previously a single
// `trace: TraceResult | null` conflated three outcomes — (a) a 500/network
// failure, (b) a genuinely empty trace, and (c) still loading — all rendering
// the same "Loading…"/"No derivation available." text. In a governance audit
// tool that falsely implied a firing rule had no traceable cause while masking a
// real backend error. The states below keep those distinct.
type RowState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; trace: TraceResult };

function EntityRow({ subject, onOpenSource }: EntityRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<RowState>({ status: "idle" });
  const ticket = subjectToTicket(subject);

  useEffect(() => {
    // Reset to loading state on (re)expand so a re-expand never flashes the
    // previous subject's trace; collapse resets back to idle.
    if (!expanded || !ticket) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    let ignore = false;
    setState({ status: "loading" });
    fetch(`/api/beliefs/why?ticket=${encodeURIComponent(ticket)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(`status ${r.status}`);
        }
        const d: unknown = await r.json();
        if (ignore) return;
        setState(
          isTraceResult(d)
            ? { status: "loaded", trace: d }
            : { status: "loaded", trace: emptyTrace(ticket) },
        );
      })
      .catch((e: unknown) => {
        // AbortError fires on unmount/collapse — not a real failure to surface.
        if (ignore || (e instanceof DOMException && e.name === "AbortError")) {
          return;
        }
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "request failed",
        });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
  }, [expanded, ticket]);

  // CTL-1103 remediate: a subject with no parseable ticket (no '/') can never be
  // fetched — the old code left it stuck on a perpetual "Loading…" spinner.
  // Surface that it is not addressable instead of pretending to load.
  if (ticket === null) {
    return (
      <div className="border-b border-border-subtle last:border-0">
        <div className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs opacity-60">
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs">{subject}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            not addressable (no ticket)
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-border-subtle last:border-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs">{subject}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          {state.status === "loading" || state.status === "idle" ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : state.status === "error" ? (
            <p className="text-xs text-destructive">
              Failed to load derivation ({state.message}).
            </p>
          ) : state.trace.beliefs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No derivation available.</p>
          ) : (
            <DerivationTree trace={state.trace} onOpenSource={onOpenSource} />
          )}
        </div>
      )}
    </div>
  );
}

interface DerivationsRailProps {
  ruleId: string;
  subjects: string[];
  onOpenSource?: (ruleId: string) => void;
}

export function DerivationsRail({ ruleId, subjects, onOpenSource }: DerivationsRailProps) {
  if (subjects.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-card p-4 text-xs text-muted-foreground">
        <span className="font-mono">{ruleId}</span> — not currently firing.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-card">
      <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium text-muted-foreground">
        <span className="font-mono">{ruleId}</span> — {subjects.length} subject
        {subjects.length !== 1 ? "s" : ""} firing
      </div>
      {subjects.map((subject) => (
        <EntityRow key={subject} subject={subject} onOpenSource={onOpenSource} />
      ))}
    </div>
  );
}
