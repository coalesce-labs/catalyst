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

// CTL-935: async so the entry guard can `await` it. `beliefs-status` delegates
// to the ASYNC shadowStatusMain (it opens beliefs.db via a dynamic import), so a
// sync main() would hand a Promise to process.exit() and crash with
// ERR_INVALID_ARG_TYPE on every invocation. `await` resolves both the sync
// (report) and async (beliefs-status) verb results to a numeric exit code.
export async function main(argv = process.argv.slice(2), opts = {}) {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "report":
      return await reportMain(rest, opts);
    case "beliefs-status":
      return await shadowStatusMain(rest, opts);
    default: {
      const out = opts.out ?? console.error;
      out(USAGE.trim());
      return 1;
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
