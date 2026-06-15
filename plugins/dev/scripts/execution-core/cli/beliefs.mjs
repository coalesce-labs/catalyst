// cli/beliefs.mjs — CTL-935: beliefs CLI noun dispatcher.
// Routes verbs: report -> beliefs/report.mjs main(); beliefs-status -> cli/beliefs-shadow-status.mjs main().
import { main as reportMain } from "../beliefs/report.mjs";
import { main as shadowStatusMain } from "./beliefs-shadow-status.mjs";

const USAGE = `usage: catalyst-execution-core beliefs <verb> [options]

verbs:
  report          compute the weekly shadow disagreement report
                  --since-days N  window in days (default 7)
                  --json          output JSON instead of markdown
  beliefs-status  verify CATALYST_BELIEFS_SHADOW is live and collection is happening
                  --db <path>     path to beliefs.db (optional)
                  --json          output JSON instead of text
`;

export function main(argv = process.argv.slice(2), opts = {}) {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "report":
      return reportMain(rest, opts);
    case "beliefs-status":
      return shadowStatusMain(rest, opts);
    default: {
      const out = opts.out ?? console.error;
      out(USAGE.trim());
      return 1;
    }
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
