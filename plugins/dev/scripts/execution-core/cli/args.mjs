// cli/args.mjs — strict argv parser shared by the execution-core audit CLI
// nouns (sessions / worktrees / branches / tidy).
//
// Why strict: the prune/tidy paths are destructive. A silently-ignored unknown
// flag, or a non-numeric value coerced to NaN, lets a typo revert a flag to its
// default or disable a safety guard with no signal — e.g. `--min-idle-seconds abc`
// would NaN-out the recency floor, or `--include-interactiv` (typo) would leave
// interactive sessions unprotected-looking while doing nothing. parseArgs rejects
// both loudly so the operator (human or agent) never acts on a misparsed command.
// (CTL-649 devex-review findings #1 and #2.)

export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArgError";
  }
}

/**
 * parseArgs — strict, typed `--flag [value]` parser.
 *
 * @param {string[]} argv      tokens after the subcommand (no node/script/verb)
 * @param {object}   spec
 * @param {string[]} spec.booleans  flag names that take no value (presence ⇒ true)
 * @param {string[]} spec.numbers   flag names whose value must parse as a finite number
 * @param {string[]} spec.strings   flag names that take a string value
 * @returns {object} parsed values keyed by flag name (kebab-case, as written),
 *                    plus `_` = array of positional (non---flag) tokens.
 * @throws {ArgError} on an unknown flag, a missing value, or a non-numeric number.
 */
export function parseArgs(argv = [], spec = {}) {
  const booleans = new Set(spec.booleans ?? []);
  const numbers = new Set(spec.numbers ?? []);
  const strings = new Set(spec.strings ?? []);
  const known = new Set([...booleans, ...numbers, ...strings]);

  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string" || !tok.startsWith("--")) {
      out._.push(tok);
      continue;
    }
    // Support `--flag=value` as well as `--flag value`.
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    let inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);

    if (!known.has(name)) {
      throw new ArgError(`unknown flag: --${name}`);
    }
    if (booleans.has(name)) {
      if (inlineVal !== undefined) {
        throw new ArgError(`flag --${name} does not take a value`);
      }
      out[name] = true;
      continue;
    }
    // value-bearing flag
    let val = inlineVal;
    if (val === undefined) {
      val = argv[++i];
    }
    if (val === undefined) {
      throw new ArgError(`flag --${name} requires a value`);
    }
    if (numbers.has(name)) {
      const n = Number(val);
      if (!Number.isFinite(n)) {
        throw new ArgError(`flag --${name} expects a number, got '${val}'`);
      }
      out[name] = n;
    } else {
      out[name] = val;
    }
  }
  return out;
}
