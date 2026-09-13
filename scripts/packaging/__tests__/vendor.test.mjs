// vendor.test.mjs — CTL-2306 Phase 2: one source, generated copies.
//
// Run: bun test scripts/packaging/__tests__/vendor.test.mjs
//
// A skill that must run on any harness carries every script and subagent prompt
// it uses inside its own directory. A file two skills share keeps ONE source under
// plugins/dev/ and each skill lists it in `agents/vendor.yaml`; the packaging CLI
// writes byte-identical copies and the drift gate fails when a copy disagrees.
// These tests pin the pure half (core/vendor.mjs): the destination rule, the
// manifest shape, and the write/drift/prune plan — plus one scratch-repo run of
// the CLI half, because pruning and file modes only mean something on a real disk.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vendorDestination, validateVendorManifest, planVendoredCopies } from "../core/vendor.mjs";
import { planPluginVendoring, applyVendoring } from "../cli.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

describe("vendorDestination", () => {
  test("a script keeps its path under the skill's scripts/", () => {
    expect(vendorDestination("scripts/lib/draft-pr.sh")).toBe("scripts/lib/draft-pr.sh");
    expect(vendorDestination("scripts/add-finding.sh")).toBe("scripts/add-finding.sh");
  });

  test("a subagent prompt lands under assets/agents/", () => {
    expect(vendorDestination("agents/codebase-locator.md")).toBe("assets/agents/codebase-locator.md");
  });

  test("anything outside scripts/ and agents/*.md is refused, naming the path", () => {
    expect(() => vendorDestination("templates/CLAUDE_SNIPPET.md")).toThrow(/templates\/CLAUDE_SNIPPET\.md/);
    expect(() => vendorDestination("agents/nested/x.md")).toThrow(/agents\/nested\/x\.md/);
    expect(() => vendorDestination("scripts/../hooks.toml")).toThrow(/\.\./);
    expect(() => vendorDestination("/etc/passwd")).toThrow();
    expect(() => vendorDestination("scripts/")).toThrow();
  });
});

describe("validateVendorManifest", () => {
  test("accepts { files: [...] } of unique, valid sources", () => {
    expect(validateVendorManifest({ files: ["scripts/a.sh", "agents/b.md"] }, "x/vendor.yaml")).toEqual({
      files: ["scripts/a.sh", "agents/b.md"],
    });
  });

  test("refuses a missing, empty, duplicated or unknown-keyed manifest, naming the file", () => {
    expect(() => validateVendorManifest(null, "x/vendor.yaml")).toThrow(/x\/vendor\.yaml/);
    expect(() => validateVendorManifest({ files: [] }, "x/vendor.yaml")).toThrow(/empty/);
    expect(() => validateVendorManifest({ files: ["scripts/a.sh", "scripts/a.sh"] }, "x/vendor.yaml")).toThrow(/duplicate/);
    expect(() => validateVendorManifest({ files: ["scripts/a.sh"], extra: 1 }, "x/vendor.yaml")).toThrow(/extra/);
    expect(() => validateVendorManifest({ files: [7] }, "x/vendor.yaml")).toThrow(/string/);
  });
});

describe("planVendoredCopies", () => {
  const entry = (overrides) => ({
    skillId: "implement-plan",
    files: ["scripts/lib/draft-pr.sh"],
    sources: { "scripts/lib/draft-pr.sh": { base64: b64("echo source\n"), mode: 0o755 } },
    current: {},
    ...overrides,
  });

  test("a missing copy is a write AND a drift entry", () => {
    const plan = planVendoredCopies([entry({ lock: ["scripts/lib/draft-pr.sh"] })]);
    expect(plan.errors).toEqual([]);
    expect(plan.writes).toEqual([
      { skillId: "implement-plan", from: "scripts/lib/draft-pr.sh", to: "scripts/lib/draft-pr.sh", base64: b64("echo source\n"), mode: 0o755 },
    ]);
    expect(plan.drift).toEqual([{ skillId: "implement-plan", from: "scripts/lib/draft-pr.sh", to: "scripts/lib/draft-pr.sh", reason: "missing" }]);
  });

  test("a byte-identical copy with the source's mode, recorded in the lock, is neither a write nor drift", () => {
    const plan = planVendoredCopies([
      entry({ current: { "scripts/lib/draft-pr.sh": { base64: b64("echo source\n"), mode: 0o755 } }, lock: ["scripts/lib/draft-pr.sh"] }),
    ]);
    expect(plan.writes).toEqual([]);
    expect(plan.drift).toEqual([]);
    expect(plan.prunes).toEqual([]);
    expect(plan.locks).toEqual([]);
  });

  // Codex review on #4133: identical bytes with a different mode (a helper made executable)
  // must not read clean — a direct `${CLAUDE_SKILL_DIR}/scripts/x.sh` run would be denied.
  test("identical bytes with a different mode is drift 'mode-differs' and a write carrying the source mode", () => {
    const plan = planVendoredCopies([
      entry({ current: { "scripts/lib/draft-pr.sh": { base64: b64("echo source\n"), mode: 0o644 } }, lock: ["scripts/lib/draft-pr.sh"] }),
    ]);
    expect(plan.drift.map((d) => d.reason)).toEqual(["mode-differs"]);
    expect(plan.writes.map((w) => w.mode)).toEqual([0o755]);
  });

  // Codex review on #4133: a copy whose entry left the manifest must be deleted, not shipped forever.
  test("a copy the lock recorded but the manifest no longer lists is pruned (drift 'undeclared') and the lock is rewritten", () => {
    const plan = planVendoredCopies([
      entry({
        current: {
          "scripts/lib/draft-pr.sh": { base64: b64("echo source\n"), mode: 0o755 },
          "scripts/old-helper.sh": { base64: b64("old\n"), mode: 0o755 },
        },
        lock: ["scripts/lib/draft-pr.sh", "scripts/old-helper.sh"],
      }),
    ]);
    expect(plan.prunes).toEqual([{ skillId: "implement-plan", to: "scripts/old-helper.sh" }]);
    expect(plan.drift).toEqual([{ skillId: "implement-plan", from: null, to: "scripts/old-helper.sh", reason: "undeclared" }]);
    expect(plan.locks).toEqual([{ skillId: "implement-plan", files: ["scripts/lib/draft-pr.sh"] }]);
  });

  test("a missing or out-of-date lock is drift 'lock-stale' and a lock write", () => {
    const plan = planVendoredCopies([entry({ current: { "scripts/lib/draft-pr.sh": { base64: b64("echo source\n"), mode: 0o755 } }, lock: null })]);
    expect(plan.drift.map((d) => d.reason)).toEqual(["lock-stale"]);
    expect(plan.locks).toEqual([{ skillId: "implement-plan", files: ["scripts/lib/draft-pr.sh"] }]);
  });

  test("a skill whose manifest is gone but whose lock remains prunes every recorded copy and drops the lock", () => {
    const plan = planVendoredCopies([
      entry({ files: [], sources: {}, current: { "assets/agents/a.md": { base64: b64("a"), mode: 0o644 } }, lock: ["assets/agents/a.md"] }),
    ]);
    expect(plan.prunes).toEqual([{ skillId: "implement-plan", to: "assets/agents/a.md" }]);
    expect(plan.locks).toEqual([{ skillId: "implement-plan", files: [] }]);
  });

  test("an edited copy is drift with reason 'differs' — the copy never wins over the source", () => {
    const plan = planVendoredCopies([
      entry({ current: { "scripts/lib/draft-pr.sh": { base64: b64("echo edited\n"), mode: 0o755 } }, lock: ["scripts/lib/draft-pr.sh"] }),
    ]);
    expect(plan.drift.map((d) => d.reason)).toEqual(["differs"]);
    expect(plan.writes[0].base64).toBe(b64("echo source\n"));
  });

  test("a listed source that does not exist is an error, never a silent skip", () => {
    const plan = planVendoredCopies([entry({ sources: { "scripts/lib/draft-pr.sh": null } })]);
    expect(plan.errors).toEqual([{ skillId: "implement-plan", from: "scripts/lib/draft-pr.sh", reason: "source-missing" }]);
    expect(plan.writes).toEqual([]);
  });

  test("an empty input set plans nothing and says so (no vacuous pass for callers that assert coverage)", () => {
    const plan = planVendoredCopies([]);
    expect(plan).toEqual({ writes: [], drift: [], errors: [], prunes: [], locks: [], skillCount: 0 });
  });
});

describe("vendoring a real plugin tree (scratch repo): write, then remove an entry, then change a mode", () => {
  const root = mkdtempSync(join(tmpdir(), "ctl-2306-vendor-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "plugins/dev");
  const skill = join(plugin, "skills/sample");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "catalyst-dev" }));
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  mkdirSync(join(plugin, "agents"), { recursive: true });
  writeFileSync(join(plugin, "scripts/helper.sh"), "#!/usr/bin/env bash\necho helper\n");
  chmodSync(join(plugin, "scripts/helper.sh"), 0o755);
  writeFileSync(join(plugin, "agents/finder.md"), "# finder\n");
  mkdirSync(join(skill, "agents"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: sample\ndescription: d\n---\nbody\n");
  const manifest = (files) => writeFileSync(join(skill, "agents/vendor.yaml"), `files:\n${files.map((f) => `  - ${f}`).join("\n")}\n`);

  test("write creates the copies with the source mode and a lock; a second plan is clean", () => {
    manifest(["scripts/helper.sh", "agents/finder.md"]);
    applyVendoring(root);
    expect(readFileSync(join(skill, "scripts/helper.sh"), "utf8")).toContain("echo helper");
    expect(statSync(join(skill, "scripts/helper.sh")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(skill, "assets/agents/finder.md"))).toBe(true);
    const again = planPluginVendoring(root);
    expect(again.drift).toEqual([]);
    expect(again.skillCount).toBe(1);
  });

  test("removing an entry from the manifest deletes its copy on the next write", () => {
    manifest(["scripts/helper.sh"]);
    expect(planPluginVendoring(root).drift.map((d) => d.reason)).toContain("undeclared");
    applyVendoring(root);
    expect(existsSync(join(skill, "assets/agents/finder.md"))).toBe(false);
    expect(planPluginVendoring(root).drift).toEqual([]);
  });

  test("a copy whose mode drifted is reported and restored", () => {
    chmodSync(join(skill, "scripts/helper.sh"), 0o644);
    expect(planPluginVendoring(root).drift.map((d) => d.reason)).toEqual(["mode-differs"]);
    applyVendoring(root);
    expect(statSync(join(skill, "scripts/helper.sh")).mode & 0o777).toBe(0o755);
  });
});

