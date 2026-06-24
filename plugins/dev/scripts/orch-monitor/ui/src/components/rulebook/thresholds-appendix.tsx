// thresholds-appendix.tsx — CTL-1103 / CTL-1320 / CTL-1328: the tunable cfg
// thresholds, in a closed-by-default Collapsible so the reading column stays
// calm. The cfg data + value rendering + descriptions are shared with the
// per-belief Thresholds section (rulebook-cfg.tsx).
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { CfgValue, cfgDescription, useBeliefCfg } from "./rulebook-cfg";

export function ThresholdsAppendix() {
  const { rows, unavailable } = useBeliefCfg();
  const count = rows?.length ?? null;

  return (
    <Collapsible id="thresholds" className="mt-10 rounded-lg border bg-card/40">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-sm">
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span>
          Thresholds{" "}
          <span className="text-muted-foreground">(the tunable numbers)</span>
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground/70">
          cfg{count != null ? ` · ${count} keys` : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-4">
          {unavailable ? (
            <p className="text-xs text-muted-foreground">Thresholds unavailable.</p>
          ) : rows == null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No thresholds configured.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="pb-2 text-left text-xs font-medium text-muted-foreground">
                    Key
                  </th>
                  <th className="pb-2 text-right text-xs font-medium text-muted-foreground">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const desc = cfgDescription(row.key);
                  return (
                    <tr
                      key={row.key}
                      id={`cfg-${row.key}`}
                      className="border-b align-top last:border-0"
                    >
                      <td className="py-2 pr-4">
                        <div className="font-mono text-xs break-all">{row.key}</div>
                        {desc && (
                          <div className="rulebook-prose mt-1 max-w-[64ch] text-[12px] leading-snug text-muted-foreground">
                            {desc}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <CfgValue row={row} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
