// source-sheet.tsx — CTL-1100 Phase 6: controlled Sheet showing rule/edge source.
// Resolves guardText, datalog, SQL from manifest or descriptor transitions[].
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";
import {
  resolveRuleSource,
  resolveEdgeSource,
  type RuleManifest,
  type FsmDescriptorLike,
  type SourceTarget,
} from "./source-target";

interface SourceSheetProps {
  open: boolean;
  onClose: () => void;
  target: SourceTarget | null;
  manifest: RuleManifest | null;
  descriptor: FsmDescriptorLike | null;
}

export function SourceSheet({ open, onClose, target, manifest, descriptor }: SourceSheetProps) {
  let guardText: string | null = null;
  let datalog: string | null = null;
  let sql: string | null = null;
  let title = "";

  if (target?.kind === "rule" && manifest) {
    title = `Rule ${target.rule_id}`;
    const info = resolveRuleSource(manifest, target);
    guardText = info?.guardText ?? null;
    datalog = info?.datalog ?? null;
    sql = info?.sql ?? null;
  } else if (target?.kind === "edge" && descriptor) {
    title = `${target.from} → ${target.to}`;
    const info = resolveEdgeSource(descriptor, target);
    guardText = info.guardText;
    datalog = info.datalog;
  }

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-[420px] sm:w-[540px]">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4 text-sm">
          <Section label="Guard" content={guardText} />
          <Section label="Datalog" content={datalog} mono />
          {sql && <Section label="SQL" content={sql} mono />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ label, content, mono = false }: { label: string; content: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      {content ? (
        <pre className={`whitespace-pre-wrap rounded bg-muted p-2 text-xs ${mono ? "font-mono" : ""}`}>
          {content}
        </pre>
      ) : (
        <p className="text-muted-foreground">no source recorded</p>
      )}
    </div>
  );
}
