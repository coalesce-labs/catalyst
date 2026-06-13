// derivation-tree.tsx — CTL-1100 Phase 6: recursive TraceResult tree.
// Modeled on board/subworker-tree.tsx. rule-id chip click → onOpenSource.
import type { TraceResult, TraceBelief, TraceSource } from "../../lib/why-model";

interface SourceChipProps {
  ruleId: string;
  onOpenSource?: (ruleId: string) => void;
}

function RuleChip({ ruleId, onOpenSource }: SourceChipProps) {
  return (
    <button
      className="rounded bg-muted px-1 py-0.5 font-mono text-xs hover:bg-muted/80"
      onClick={() => onOpenSource?.(ruleId)}
      type="button"
    >
      {ruleId}
    </button>
  );
}

interface SourceRowProps {
  source: TraceSource;
}

function SourceRow({ source }: SourceRowProps) {
  return (
    <li className="flex items-start gap-1 text-xs text-muted-foreground">
      <span className="shrink-0 font-mono">[{source.table}#{source.id}]</span>
      <span className="truncate">{source.summary}</span>
    </li>
  );
}

interface BeliefNodeProps {
  belief: TraceBelief;
  onOpenSource?: (ruleId: string) => void;
}

function BeliefNode({ belief, onOpenSource }: BeliefNodeProps) {
  return (
    <div className="rounded border border-border p-2 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <span>{belief.name}({belief.subject})</span>
        <RuleChip ruleId={belief.rule_id} onOpenSource={onOpenSource} />
        {belief.value && <span className="text-muted-foreground">{belief.value}</span>}
      </div>
      {belief.sources.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-3">
          {belief.sources.map((s, i) => (
            <SourceRow key={i} source={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface DerivationTreeProps {
  trace: TraceResult;
  onOpenSource?: (ruleId: string) => void;
}

export function DerivationTree({ trace, onOpenSource }: DerivationTreeProps) {
  if (!trace.tickId) {
    return <p className="text-sm text-muted-foreground">no derivation recorded</p>;
  }
  if (trace.beliefs.length === 0) {
    return <p className="text-sm text-muted-foreground">no beliefs at tick #{trace.tickId}</p>;
  }
  return (
    <div className="space-y-2">
      {trace.beliefs.map((b) => (
        <BeliefNode key={b.belief_id} belief={b} onOpenSource={onOpenSource} />
      ))}
    </div>
  );
}
