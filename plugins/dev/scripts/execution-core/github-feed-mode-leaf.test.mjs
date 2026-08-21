// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-mode-leaf.test.mjs

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_GITHUB_FEED_MODE,
  GITHUB_FEED_MODES,
  githubFeedIsAuthoritative,
  resolveGithubFeedMode,
} from "../lib/github-feed-mode.mjs";
import {
  GITHUB_CONSUMED_NAMES,
  GITHUB_LOSSY_NAMES,
  GITHUB_SUPPRESSIBLE_NAMES,
  GITHUB_UNCOVERED_NAMES,
  computeSuppressible,
} from "../lib/github-feed-names.mjs";
import { readGithubFeedConfig } from "./config.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-feed-mode-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* never fail in cleanup */ } });

const l2 = (obj) => {
  const p = join(tmp, `l2-${Math.abs(JSON.stringify(obj).length)}-${Object.keys(obj).length}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
const r = (env, path) => resolveGithubFeedMode({ env, layer2ConfigPath: path ?? join(tmp, "absent.json") });

describe("the ladder: env → Layer-2 → off", () => {
  test("unset resolves to the default, and says the source was the default", () => {
    expect(r({})).toEqual({ mode: DEFAULT_GITHUB_FEED_MODE, intervalSec: 30, source: "default" });
  });

  test("every valid env value is honoured", () => {
    for (const mode of GITHUB_FEED_MODES) {
      expect(r({ CATALYST_GITHUB_FEED: mode })).toMatchObject({ mode, source: "env" });
    }
  });

  test("`0` means off, explicitly from env", () => {
    expect(r({ CATALYST_GITHUB_FEED: "0" })).toMatchObject({ mode: "off", source: "env" });
  });

  test("Layer-2 is read when env is unset", () => {
    const p = l2({ catalyst: { githubFeed: { mode: "enforce", intervalSeconds: 45 } } });
    expect(r({}, p)).toEqual({ mode: "enforce", intervalSec: 45, source: "layer2" });
  });

  test("env beats Layer-2", () => {
    const p = l2({ catalyst: { githubFeed: { mode: "enforce" } } });
    expect(r({ CATALYST_GITHUB_FEED: "shadow" }, p)).toMatchObject({ mode: "shadow", source: "env" });
  });
});

describe("⛔ CAT-57's rule: a SET-but-invalid env value falls back to off AND overrides Layer-2", () => {
  const p = () => l2({ catalyst: { githubFeed: { mode: "enforce" } } });

  test("baseline — with no env var, Layer-2 enforce is honoured", () => {
    expect(r({}, p())).toMatchObject({ mode: "enforce", source: "layer2" });
  });

  test("a typo does NOT fall through to Layer-2 enforce", () => {
    // ⛔ The failure direction that matters: an operator reaching for the env var to
    // REDUCE actuation must not silently leave a Layer-2 enforce live. This is the
    // behaviour execution-core/config.mjs's own readGithubFeedConfig did NOT have
    // before it delegated here.
    for (const typo of ["enfroce", "shadwo", "ENFORCE", "enforce ", "1", "true"]) {
      const v = r({ CATALYST_GITHUB_FEED: typo }, p());
      expect(v.mode).toBe("off");
      expect(v.source).toBe("env-invalid");
    }
  });

  test("⚠️ but an EMPTY or whitespace var still defers to Layer-2 — unset, not invalid", () => {
    // `export CATALYST_GITHUB_FEED=` is the same operator intent as not setting it.
    // Treating it as a typo would let an empty var silently disable a Layer-2 rollout.
    for (const empty of ["", "   ", "\t"]) {
      expect(r({ CATALYST_GITHUB_FEED: empty }, p())).toMatchObject({ mode: "enforce", source: "layer2" });
    }
  });
});

describe("the interval", () => {
  test("below the floor, absent, or unparseable → the default", () => {
    for (const v of ["", "0", "1", "4", "nonsense", null, undefined]) {
      expect(r({ CATALYST_GITHUB_FEED_INTERVAL_SEC: v }).intervalSec).toBe(30);
    }
  });
  test("a valid value is honoured and floored to an integer", () => {
    expect(r({ CATALYST_GITHUB_FEED_INTERVAL_SEC: "60" }).intervalSec).toBe(60);
    expect(r({ CATALYST_GITHUB_FEED_INTERVAL_SEC: "45.9" }).intervalSec).toBe(45);
  });
});

describe("⛔ githubFeedIsAuthoritative is named for the RULE, not the comparison", () => {
  test("only enforce is authoritative", () => {
    expect(githubFeedIsAuthoritative({ env: { CATALYST_GITHUB_FEED: "enforce" } })).toBe(true);
    // ⚠️ shadow especially: in shadow nothing the producer emits is authoritative and
    // the dispatch gate suppresses nothing, so a caller that widened this to
    // `!== "off"` would close the smee tunnel on a host that only meant to observe —
    // taking GitHub ingestion to zero.
    expect(githubFeedIsAuthoritative({ env: { CATALYST_GITHUB_FEED: "shadow" } })).toBe(false);
    expect(githubFeedIsAuthoritative({ env: { CATALYST_GITHUB_FEED: "off" } })).toBe(false);
    expect(githubFeedIsAuthoritative({ env: {} })).toBe(false);
  });
});

describe("⛔ config.mjs DELEGATES — the two readers cannot disagree", () => {
  test("readGithubFeedConfig agrees with the leaf across the whole ladder", () => {
    // The property that matters: not that either is right in isolation, but that a
    // producer reading one and a tunnel gate reading the other get the same answer.
    for (const env of [
      {}, { CATALYST_GITHUB_FEED: "shadow" }, { CATALYST_GITHUB_FEED: "enforce" },
      { CATALYST_GITHUB_FEED: "0" }, { CATALYST_GITHUB_FEED: "enfroce" },
      { CATALYST_GITHUB_FEED_INTERVAL_SEC: "90" },
    ]) {
      const withHome = { ...env, HOME: tmp };
      const viaConfig = readGithubFeedConfig(withHome);
      const viaLeaf = resolveGithubFeedMode({ env: withHome });
      expect(viaConfig.mode).toBe(viaLeaf.mode);
      expect(viaConfig.intervalSec).toBe(viaLeaf.intervalSec);
    }
  });
});

describe("⛔ both leaves load under BARE NODE — the constraint doctor.mjs actually has", () => {
  const node = process.execPath.includes("bun") ? "node" : process.execPath;
  const leafDir = join(import.meta.dir, "..", "lib");

  for (const leaf of ["github-feed-mode.mjs", "github-feed-names.mjs"]) {
    test(`${leaf} imports cleanly under bare node`, () => {
      // Spawned, not imported: this test file runs under bun, where bun:sqlite
      // resolves fine, so an in-process import would pass for a module doctor
      // cannot actually load. The whole point is the OTHER runtime.
      const out = execFileSync(node, ["-e", `import(${JSON.stringify(join(leafDir, leaf))}).then(()=>console.log("OK"))`], {
        encoding: "utf8",
      });
      expect(out).toContain("OK");
    });
  }

  test("⚠️ control: github-feed-gate.mjs REJECTS under bare node", () => {
    // The negative control that makes the two above meaningful — if bare node
    // loaded everything, moving the name lists to a leaf bought nothing.
    let threw = false;
    try {
      execFileSync(node, ["-e", `import(${JSON.stringify(join(import.meta.dir, "github-feed-gate.mjs"))})`], {
        encoding: "utf8", stdio: "pipe",
      });
    } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe("the name lists are ONE source, shared by producer, gate and doctor", () => {
  test("the gate re-exports the leaf's lists rather than keeping its own", async () => {
    const gate = await import("./github-feed-gate.mjs");
    expect(gate.GITHUB_CONSUMED_NAMES).toBe(GITHUB_CONSUMED_NAMES);
    expect(gate.GITHUB_UNCOVERED_NAMES).toBe(GITHUB_UNCOVERED_NAMES);
    expect(gate.GITHUB_SUPPRESSIBLE_NAMES).toEqual(GITHUB_SUPPRESSIBLE_NAMES);
  });

  test("⭐ the derivation still derives — driven with different inputs", () => {
    const afterAllGapsClose = computeSuppressible({
      consumed: GITHUB_CONSUMED_NAMES, uncovered: [], lossy: [],
    });
    expect(afterAllGapsClose).toEqual(GITHUB_CONSUMED_NAMES);
    expect(GITHUB_SUPPRESSIBLE_NAMES.length).toBe(
      GITHUB_CONSUMED_NAMES.length - GITHUB_UNCOVERED_NAMES.length - GITHUB_LOSSY_NAMES.length,
    );
  });
});
