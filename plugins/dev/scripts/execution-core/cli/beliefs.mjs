// cli/beliefs.mjs — CTL-935 Phase 5: beliefs CLI noun dispatcher.
// Routes verbs: report -> beliefs/report.mjs main().
import { main as reportMain } from "../beliefs/report.mjs";

const USAGE = `usage: catalyst-execution-core beliefs <verb> [options]

verbs:
  report   compute the weekly shadow disagreement report
           --since-days N  window in days (default 7)
           --json          output JSON instead of markdown
`;

export function main(argv = process.argv.slice(2), opts = {}) {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "report":
      return reportMain(rest, opts);
    default:
      const out = opts.out ?? console.error;
      out(USAGE.trim());
      return 1;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
