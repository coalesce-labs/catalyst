// board-vocabulary.test.mjs — CTL-2300 Tier 1 + the FULL Tier-2 deny-list.
//
// Three halves, and the last two are the ones that keep the ticket fixed.
//
//   1. the resolvers' ladders — ask labels, the not-an-ask label, and the stage-name slot
//      resolution with its refusal;
//   2. ⭐ THE DENY-LIST SCAN. cloud-facts.test.mjs's scan forbade exactly one string (the
//      retired cloud host). This one forbids the WHOLE list the ticket names — a stage name,
//      a label name, a team key, and the stale write-budget threshold — with the committed
//      `tenant-contract.default.json` as the single allowed source, which is what the Tier-2
//      acceptance criterion actually asks for;
//   3. LOCKSTEP: the contract's stage table and linear-transition.sh's bootstrap table must
//      agree. Two bootstraps that drift are worse than one, because the write path and the
//      read path would then disagree about the same board and neither would say so.
//
// ## Why the scan is ARGUMENT-POSITION, not substring
//
// AGENTS.md's positive-control rule cuts both ways: a scan that cannot fire is useless, and a
// scan that fires on everything gets deleted. `Backlog`, `Done` and `Triage` are ordinary
// English that appears in hundreds of lines of legitimate prose in this tree — an ADR heading,
// a gotcha, a sentence about triaging PRs. What is actually forbidden is a stage name reaching
// a Linear QUERY: `--status "In Progress"`, `--state Done`, `--team CTL`, `--labels
// "catalyst-ask"`. That is precisely the drift, it is precisely what a reader copy-pastes, and
// it is matchable without guessing. Prose that MENTIONS a stage name is documentation; prose
// that PASSES one is an instruction to query somebody else's board with our word for it.
//
// ## Why tests are excluded from the corpus
//
// A test asserting `--status Done` reaches linearis is testing the resolver, and the fixture
// for a tenant that calls its stage "Done" has to say "Done". Excluding `*.test.*` and
// `__tests__/` is not a loophole — those files ship to nobody.
//
// ⛔ THREE POSITIVE CONTROLS, per AGENTS.md: a corpus walk that silently reads zero files
// passes every absence assertion vacuously and reads exactly like a clean bill of health. So
// the scan asserts it READ a populated corpus, that its matcher returns non-zero on a string
// known to be present, and that each forbidden PATTERN finds a planted violation in a file of
// exactly the scanned shape. The third is the one that matters here: an argument-position
// regex that is subtly wrong matches nothing and certifies the tree clean.
//
// Run: `bun test board-vocabulary.test.mjs` from plugins/dev/scripts/lib. Named explicitly in
// .github/workflows/execution-core-tests.yml so a
// `grep -n board-vocabulary.test .github/workflows/execution-core-tests.yml` returns a hit — a
// suite discovered by nothing is a suite that never runs.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASK_LABELS_CONFIG_PATH,
  ASK_LABELS_ENV,
  CONTRACT,
  CONTRACT_ASK_LABEL_NAMES,
  NOT_AN_ASK_CONFIG_PATH,
  NOT_AN_ASK_ENV,
  resolveAskLabelNames,
  resolveNotAnAskLabel,
  resolveStateName,
} from "./board-vocabulary.mjs";
import { DEFAULT_HOST_DAILY_WRITE_BUDGET } from "./cloud-facts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

/** A path that exists nowhere, for pinning a layer OFF in a resolver call. */
const ABSENT = join(tmpdir(), "catalyst-board-vocab-absent", "config.json");

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "board-vocab-"));
}

function writeConfig(dir, rel, body) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(body));
  return full;
}

// ── the label ladders ──────────────────────────────────────────────────────────────────

describe("resolveAskLabelNames — env → layer1 → layer2 → contract", () => {
  test("with nothing configured it resolves the CONTRACT's labels", () => {
    expect(
      resolveAskLabelNames({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT }),
    ).toEqual({ names: [...CONTRACT.linear.askLabels], source: "contract" });
  });

  test("a tenant's own labels win, from either layer, and env wins over both", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { linear: { askLabels: ["decision", "needs-ryan"] } },
    });
    const l2 = writeConfig(dir, "home/config.json", {
      catalyst: { linear: { askLabels: ["machine-wide"] } },
    });
    expect(resolveAskLabelNames({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: l2 })).toEqual({
      names: ["decision", "needs-ryan"],
      source: "layer1",
    });
    expect(
      resolveAskLabelNames({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: l2 }),
    ).toEqual({ names: ["machine-wide"], source: "layer2" });
    expect(
      resolveAskLabelNames({
        env: { [ASK_LABELS_ENV]: " one , two " },
        layer1ConfigPath: l1,
        layer2ConfigPath: l2,
      }),
    ).toEqual({ names: ["one", "two"], source: "env" });
  });

  test("a MALFORMED declaration falls through rather than filing under a blank label", () => {
    // `[]`, `["a", ""]`, a number, an object: each would produce a label list the ask is
    // filed under and then invisible to. Falling through to the next rung is the only
    // answer that cannot silently mis-file.
    for (const bad of [[], ["a", ""], 7, { a: 1 }, "", " , "]) {
      const dir = fixtureDir();
      const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
        catalyst: { linear: { askLabels: bad } },
      });
      expect(
        resolveAskLabelNames({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: ABSENT }).source,
      ).toBe("contract");
    }
  });

  test("the returned array is a COPY — a caller cannot mutate the contract for the process", () => {
    const first = resolveAskLabelNames({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT });
    first.names.push("injected");
    expect(
      resolveAskLabelNames({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT }).names,
    ).toEqual([...CONTRACT.linear.askLabels]);
  });
});

describe("resolveNotAnAskLabel — the CTC-1752 release label", () => {
  test("defaults to the contract and is overridable from config or env", () => {
    expect(
      resolveNotAnAskLabel({ env: {}, layer1ConfigPath: ABSENT, layer2ConfigPath: ABSENT }),
    ).toEqual({ name: CONTRACT.linear.notAnAskLabel, source: "contract" });
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { linear: { notAnAskLabel: "not-a-decision" } },
    });
    expect(
      resolveNotAnAskLabel({ env: {}, layer1ConfigPath: l1, layer2ConfigPath: ABSENT }),
    ).toEqual({ name: "not-a-decision", source: "layer1" });
    expect(
      resolveNotAnAskLabel({ env: { [NOT_AN_ASK_ENV]: "release-me" }, layer1ConfigPath: l1 }),
    ).toEqual({ name: "release-me", source: "env" });
  });
});

// ── the stage-name resolver ────────────────────────────────────────────────────────────

describe("resolveStateName — slot, not name", () => {
  test("a repo that declares NO stateMap bootstraps from the contract", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", { catalyst: { linear: { teamKey: "ENG" } } });
    expect(resolveStateName("inProgress", { env: {}, layer1ConfigPath: l1 })).toEqual({
      ok: true,
      name: CONTRACT.linear.stateNames.inProgress,
      slot: "inProgress",
      source: "contract",
    });
  });

  test("a tenant's own name wins, and a project map beats the global one", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: {
        linear: { teamKey: "ACME", stateMap: { inProgress: "Building", done: "Shipped" } },
        projects: [{ key: "ACME", stateMap: { inProgress: "Cooking" } }],
      },
    });
    expect(resolveStateName("inProgress", { env: {}, layer1ConfigPath: l1 })).toEqual({
      ok: true,
      name: "Cooking",
      slot: "inProgress",
      source: "project",
    });
    expect(resolveStateName("done", { env: {}, layer1ConfigPath: l1 })).toEqual({
      ok: true,
      name: "Shipped",
      slot: "done",
      source: "global",
    });
  });

  test("⭐ a tenant that DECLARES a stateMap and omits the slot is REFUSED, not guessed at", () => {
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: { linear: { teamKey: "ACME", stateMap: { done: "Shipped" } } },
    });
    const r = resolveStateName("inProgress", { env: {}, layer1ConfigPath: l1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("slot-not-mapped");
    // The refusal has to NAME the slot and the file, or it is one more thing to go and look up.
    expect(r.message).toContain("inProgress");
    expect(r.message).toContain(l1);
    // …and it must not have leaked our own word for the stage as the answer.
    expect(r.name).toBeUndefined();
  });

  test("⛔ an EMPTY project stateMap does not read as 'nothing declared' (round-1 Codex P1)", () => {
    // `stateMap: {}` on the matching project is an object, so a `//`-style chain that asks
    // only the project's map concludes "nothing declared" and falls through to the guess —
    // for exactly the tenant with a populated GLOBAL map that this guard exists to protect.
    const dir = fixtureDir();
    const l1 = writeConfig(dir, "repo/.catalyst/config.json", {
      catalyst: {
        linear: { teamKey: "ACME", stateMap: { done: "Shipped" } },
        projects: [{ key: "ACME", stateMap: {} }],
      },
    });
    expect(resolveStateName("inProgress", { env: {}, layer1ConfigPath: l1 }).reason).toBe(
      "slot-not-mapped",
    );
  });

  test("an unknown slot is a NAMED failure that lists the real slots", () => {
    const r = resolveStateName("inprogress", { env: {}, layer1ConfigPath: ABSENT });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown-slot");
    expect(r.message).toContain("inProgress");
  });
});

// ── LOCKSTEP with the write path ───────────────────────────────────────────────────────

describe("the contract and linear-transition.sh agree about the bootstrap table", () => {
  test("⭐ every slot linear-transition.sh bootstraps has the same name in the contract", () => {
    // linear-transition.sh stays the single source of truth for the WRITE path (it is bash,
    // it runs on a host with no node), so the contract does not replace its table — it has to
    // MATCH it. Two bootstraps that drift would have the read path and the write path
    // disagreeing about one board, silently, in opposite directions.
    const sh = readFileSync(join(REPO_ROOT, "plugins/dev/scripts/linear-transition.sh"), "utf8");
    const body = sh.slice(sh.indexOf("default_state_for()"), sh.indexOf("TICKET=\"\""));
    const rows = [...body.matchAll(/^\s{4}([a-zA-Z]+)\)\s+echo "([^"]+)"/gm)];

    // POSITIVE CONTROL: the parse found the table, not an empty match set.
    expect(rows.length).toBeGreaterThan(8);

    for (const [, slot, name] of rows) {
      expect(`${slot}=${CONTRACT.linear.stateNames[slot]}`).toBe(`${slot}=${name}`);
    }
    // …and the contract carries no slot the script cannot bootstrap.
    const shSlots = new Set(rows.map(([, slot]) => slot));
    for (const slot of Object.keys(CONTRACT.linear.stateNames)) expect(shSlots.has(slot)).toBe(true);
  });

  test("the mirrored write budget in cloud-facts.mjs is the contract's number", () => {
    expect(DEFAULT_HOST_DAILY_WRITE_BUDGET).toBe(CONTRACT.cloud.hostDailyWriteBudget);
  });
});

// ── the deny-list scan ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", "__tests__"]);

function walk(dir, keep, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, keep, out);
      continue;
    }
    let isFile = e.isFile();
    if (!isFile && e.isSymbolicLink()) {
      try {
        isFile = statSync(full).isFile();
      } catch {
        continue;
      }
    }
    if (isFile && keep(e.name)) out.push(full);
  }
  return out;
}

/**
 * The SHIPPED surface: skill text plus the scripts a customer runs.
 *
 * ⚠️ `*.test.*` and `__tests__/` are excluded — a suite that cannot name the literal it
 * forbids cannot assert anything about it, and those files ship to nobody. `lib/` is scanned
 * apart from the two files that DECLARE the vocabulary: this module and the contract's own
 * reader.
 */
function shippedFiles() {
  const skills = walk(join(REPO_ROOT, "plugins/dev/skills"), (n) => n.endsWith(".md"));
  const scripts = walk(
    join(REPO_ROOT, "plugins/dev/scripts"),
    (n) => (n.endsWith(".mjs") || n.endsWith(".sh")) && !n.includes(".test."),
  ).filter(
    (f) =>
      !f.endsWith(join("lib", "board-vocabulary.mjs")) && !f.endsWith(join("lib", "cloud-facts.mjs")),
  );
  return [...skills, ...scripts];
}

/** Every (file, line) whose text matches — the report a failure has to be actionable from. */
function linesMatching(files, re) {
  const hits = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // unreadable file — not evidence either way
    }
    text.split("\n").forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${f.slice(REPO_ROOT.length + 1)}:${i + 1}`);
    });
  }
  return hits;
}

/** `--status "In Progress"` / `--state Done` / `--status "Triage,Backlog"`. */
function stageArgPattern(names) {
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`--(?:status|state)[= ]+"?(?:[^"\\n]*[,|])?(?:${alt})\\b`);
}

/** `--team CTL` / `--team "CTC"`. */
function teamArgPattern(keys) {
  return new RegExp(`--team[= ]+"?(?:${keys.join("|")})\\b`);
}

/** `--labels "catalyst-ask,ask/decision"` / `--label ask/decision`. */
function labelArgPattern(names) {
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`--labels?[= ]+"?(?:[^"\\n]*,)?(?:${alt})\\b`);
}

/**
 * The pre-CTC-796 write budget, DECLARED — `hostDailyWriteBudget: 300`, `WRITE_BUDGET=300`.
 *
 * ⚠️ Bound to the identifier, NOT to prose containing the number. The first draft of this rule
 * matched `300` anywhere within 60 characters of the word "budget" and reddened on eight lines
 * that were all TRUE INCIDENT HISTORY — "mini-2 spent its entire daily cloud write budget —
 * 300/300 for UTC 2026-08-18". Forbidding an accurate record of what the cap WAS is not what
 * this ticket asked for, and a rule that makes correct history illegal gets deleted rather than
 * obeyed. What must never come back is the stale number bound to the live threshold.
 */
const STALE_BUDGET = /(?:hostDailyWriteBudget|HOST_DAILY_WRITE_BUDGET|[Ww]riteBudget|WRITE_BUDGET|writeBudgetCap)\s*[:=]\s*300\b/;

describe("no tenant-shaped literal survives in the shipped surface (CTL-2300 Tier 2)", () => {
  const files = shippedFiles();
  const stageNames = [...new Set(Object.values(CONTRACT.linear.stateNames))];
  const labelNames = [...CONTRACT.linear.askLabels, CONTRACT.linear.notAnAskLabel];
  const teamKeys = CONTRACT.linear.knownTeamKeys;

  test("POSITIVE CONTROL 1: the scan actually read a populated corpus", () => {
    // A silent zero-file walk would make every assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    // …and the matcher returns non-zero on a string that is present by construction.
    expect(linesMatching(files, /check-project-setup/).length).toBeGreaterThan(0);
  });

  test("POSITIVE CONTROL 2: every forbidden PATTERN fires on a planted violation", () => {
    // ⭐ The control this suite most needs. An argument-position regex that is subtly wrong
    // matches nothing and certifies the whole tree clean — the exact silent-instrument shape
    // AGENTS.md names. So each pattern is run against a file of exactly the scanned shape
    // carrying exactly the violation it is meant to catch.
    const dir = fixtureDir();
    const plant = (name, body) => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return [p];
    };
    expect(
      linesMatching(plant("a.sh", `linearis issues list --status "In Progress"\n`), stageArgPattern(stageNames)),
    ).toHaveLength(1);
    expect(
      linesMatching(plant("b.sh", `linearis issues list --status "Triage,Backlog"\n`), stageArgPattern(stageNames)),
    ).toHaveLength(1);
    expect(
      linesMatching(plant("c.sh", `linear-transition.sh --state Done\n`), stageArgPattern(stageNames)),
    ).toHaveLength(1);
    expect(linesMatching(plant("d.sh", `ask.mjs create --team CTL\n`), teamArgPattern(teamKeys))).toHaveLength(1);
    expect(
      linesMatching(plant("e.sh", `issues create --labels "catalyst-ask,ask/decision"\n`), labelArgPattern(labelNames)),
    ).toHaveLength(1);
    expect(
      linesMatching(plant("f.mjs", `export const HOST_DAILY_WRITE_BUDGET = 300;\n`), STALE_BUDGET),
    ).toHaveLength(1);
    // …and each pattern is NARROW: prose that merely mentions the word is not a violation.
    expect(linesMatching(plant("g.md", `Triage the backlog, then mark it Done.\n`), stageArgPattern(stageNames))).toEqual([]);
    expect(linesMatching(plant("h.md", `the CTL team owns this\n`), teamArgPattern(teamKeys))).toEqual([]);
    // …including the budget rule, whose first draft made accurate incident history illegal.
    expect(
      linesMatching(plant("i.md", `mini-2 spent 300/300 of its daily write budget that day\n`), STALE_BUDGET),
    ).toEqual([]);
  });

  test("⭐ no stage NAME is passed to a Linear query in shipped text", () => {
    // A stage name a board does not use makes `--status` return an EMPTY list, not an error —
    // so this is the silent half of the ticket. Resolve the slot:
    // `linear-transition.sh --print-state --transition <slot> --team <KEY>`.
    expect(linesMatching(files, stageArgPattern(stageNames))).toEqual([]);
  });

  test("⭐ no fleet TEAM KEY is passed to a Linear command in shipped text", () => {
    // Our team keys are not any customer's. Read `catalyst.linear.teamKey`, or let the verb
    // resolve it (lib/tenant-identity.mjs's resolveAskTeam, which refuses rather than guesses).
    expect(linesMatching(files, teamArgPattern(teamKeys))).toEqual([]);
  });

  test("⭐ no ask LABEL NAME is passed to a Linear command in shipped text", () => {
    // Labels are team-scoped in Linear: passing the name resolves it against whichever team
    // linearis picked. resolveAskLabelNames() + ask.mjs's resolveTeamLabelIds is the path.
    expect(linesMatching(files, labelArgPattern(labelNames))).toEqual([]);
  });

  test("⭐ the pre-CTC-796 write budget appears nowhere as a documented threshold", () => {
    expect(linesMatching(files, STALE_BUDGET)).toEqual([]);
  });

  test("⭐ the retired cloud estate still appears nowhere (cloud-facts.test.mjs's rule, re-run here)", () => {
    // Deliberately duplicated across the two suites: this is the one literal that has already
    // shipped wrong, and a rule that lives in exactly one file is a rule one deletion removes.
    expect(linesMatching(files, /catalyst-cloud\.coalescelabs\.ai/)).toEqual([]);
  });

  test("⭐ the config keys these literals moved to are documented for an operator", () => {
    // A resolver an operator cannot discover is a resolver nobody sets: the whole point of
    // moving a literal to config is that a customer can now declare their own.
    const docs = readFileSync(
      join(REPO_ROOT, "website/src/content/docs/reference/configuration.md"),
      "utf8",
    );
    expect(docs).toContain(ASK_LABELS_CONFIG_PATH);
    expect(docs).toContain(NOT_AN_ASK_CONFIG_PATH);
    expect(docs).toContain(ASK_LABELS_ENV);
    expect(docs).toContain(NOT_AN_ASK_ENV);
  });

  test("the ask label list has exactly ONE definition in the tree", () => {
    // Three modules kept their own frozen copy before this ticket. They now re-export
    // CONTRACT_ASK_LABEL_NAMES; the contract JSON is the only place the strings are written.
    const definitions = linesMatching(
      files,
      /(?:const|export const)[^\n]*=\s*Object\.freeze\(\[[^\]]*["']catalyst-ask["']/,
    );
    expect(definitions).toEqual([]);
    expect([...CONTRACT_ASK_LABEL_NAMES]).toEqual([...CONTRACT.linear.askLabels]);
  });
});
