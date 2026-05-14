// broker-interests-reader.test.ts — verifies the broker-interests.json parser.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBrokerInterests } from "./broker-interests-reader.ts";

describe("readBrokerInterests", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "hud-bi-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("missing file → empty array", () => {
    expect(readBrokerInterests(join(tmp, "missing.json"))).toEqual([]);
  });

  test("malformed JSON → empty array", () => {
    const target = join(tmp, "bad.json");
    writeFileSync(target, "{ not valid");
    expect(readBrokerInterests(target)).toEqual([]);
  });

  test("non-array root → empty array", () => {
    const target = join(tmp, "obj.json");
    writeFileSync(target, JSON.stringify({ foo: "bar" }));
    expect(readBrokerInterests(target)).toEqual([]);
  });

  test("parses a prose interest tuple", () => {
    const target = join(tmp, "good.json");
    writeFileSync(target, JSON.stringify([
      [
        "orch-foo",
        {
          notify_event: "filter.wake.orch-foo",
          prompt: "wake when X",
          context: { pr_numbers: [123], tickets: ["FOO-1"] },
          orchestrator: "orch-foo",
          session_id: null,
          persistent: true,
          interest_type: null,
          pr_numbers: null,
          repo: null,
          base_branches: null,
          tickets: null,
          wake_on: null,
        },
      ],
    ]));
    const result = readBrokerInterests(target);
    expect(result).toHaveLength(1);
    const r = result[0];
    expect(r.key).toBe("orch-foo");
    expect(r.interest_type).toBeNull();
    expect(r.prompt).toBe("wake when X");
    expect(r.context?.pr_numbers).toEqual([123]);
    expect(r.context?.tickets).toEqual(["FOO-1"]);
    expect(r.persistent).toBe(true);
  });

  test("parses a structured pr_lifecycle interest", () => {
    const target = join(tmp, "good.json");
    writeFileSync(target, JSON.stringify([
      [
        "orch-bar-pr-lifecycle",
        {
          notify_event: "filter.wake.orch-bar",
          prompt: "",
          context: null,
          orchestrator: "orch-bar",
          session_id: null,
          persistent: true,
          interest_type: "pr_lifecycle",
          pr_numbers: [599],
          repo: "coalesce-labs/catalyst",
          base_branches: [{ pr: 599, base: "main" }],
          tickets: null,
          wake_on: null,
        },
      ],
    ]));
    const result = readBrokerInterests(target);
    expect(result).toHaveLength(1);
    const r = result[0];
    expect(r.interest_type).toBe("pr_lifecycle");
    expect(r.pr_numbers).toEqual([599]);
    expect(r.repo).toBe("coalesce-labs/catalyst");
    expect(r.base_branches).toEqual([{ pr: 599, base: "main" }]);
  });

  test("skips malformed tuple entries (non-tuple, missing key, etc.)", () => {
    const target = join(tmp, "mixed.json");
    writeFileSync(target, JSON.stringify([
      "not a tuple",
      [42, { stuff: "ignored" }],            // key is not a string
      ["valid", {
        notify_event: "filter.wake.x",
        prompt: "",
        context: null,
        orchestrator: "x",
        session_id: null,
        persistent: false,
        interest_type: null,
        pr_numbers: null,
        repo: null,
        base_branches: null,
        tickets: null,
        wake_on: null,
      }],
    ]));
    const result = readBrokerInterests(target);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("valid");
  });

  test("tolerates absent optional fields", () => {
    const target = join(tmp, "min.json");
    writeFileSync(target, JSON.stringify([["k", { orchestrator: "o" }]]));
    const result = readBrokerInterests(target);
    expect(result).toHaveLength(1);
    expect(result[0].orchestrator).toBe("o");
    expect(result[0].prompt).toBe("");
    expect(result[0].persistent).toBe(false);
  });
});
