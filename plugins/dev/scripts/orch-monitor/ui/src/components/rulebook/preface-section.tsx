// preface-section.tsx — CTL-1320: the Rulebook opening, reframed.
// Lead with plain, approachable prose (no card, capped measure); the daemon's
// terms of art are italicized inline, never headlined. The dense Datalog primer
// is tucked into a closed-by-default Collapsible so a newcomer is not met by a
// wall of text. The reframed "why" is the surface's editorial voice; the engine's
// canonical preface.problem stays in the manifest for API consumers.
import type { Preface } from "@/lib/rulebook-model";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";

export function PrefaceSection({ preface }: { preface: Preface }) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-semibold mb-2">Why this engine exists</h2>
      <div className="space-y-3 text-[15px] leading-7 text-foreground/90">
        <p>
          Every few seconds, the daemon has to answer one question on its own:
          who&apos;s actually working, and who only looks like they are? A worker
          can be running but stuck (<em>stalled-alive</em>), checked in but never
          actually start (<em>never-started wedge</em>), or busily producing output
          against a board that no longer matches Linear (<em>board drift</em>).
        </p>
        <p>
          This engine is that reasoning. It starts from plain observations —
          heartbeats, turns, job states — and walks them up until it reaches a
          verdict: alive, wedged, retry, or get-a-human. Nothing is a black box:
          open any belief and trace which facts triggered which rule.
        </p>
        <p className="text-muted-foreground">
          The engine reasons in layers — each rule turns facts it already trusts
          into a new, named belief. That layering (its <em>strata</em>) keeps the
          logic ordered and every conclusion traceable.
        </p>
      </div>

      <Collapsible className="mt-5 rounded-lg border bg-card/40">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-sm">
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span>
            How the rules work{" "}
            <span className="text-muted-foreground">(the Datalog model)</span>
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground/70">
            17 rules · rules.dl
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="px-4 pb-4 text-sm leading-relaxed text-muted-foreground">
            {preface.datalog_primer}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
