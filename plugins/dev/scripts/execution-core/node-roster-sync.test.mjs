// node-roster-sync.test.mjs — synchronous bridge over the node-roster CLI
// (CTL-1273). Every test injects a fake `spawn` so nothing forks a process.
// Mirrors cluster-heartbeat-sync.test.mjs in structure and fail-open contract.
import { describe, test, expect } from "bun:test";
import { readNodeNamesSync, registerNodeSync, deregisterNodeSync } from "./node-roster-sync.mjs";

describe("readNodeNamesSync — argv + fail-open contract", () => {
  test("ok:true with the parsed names array", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify(["mini", "mini-2"]) + "\n" });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: true,
      names: ["mini", "mini-2"],
    });
  });

  test("ok:true with [] when the anchor is readable but empty", () => {
    const spawn = () => ({ status: 0, stdout: "[]\n" });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: true,
      names: [],
    });
  });

  test("builds the right argv: <node> <cli> names <anchor>", () => {
    let capturedBin, capturedArgs;
    const spawn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      return { status: 0, stdout: "[]\n" };
    };
    readNodeNamesSync(
      { anchorIssue: "CTL-9" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/node-roster.mjs" }
    );
    expect(capturedBin).toBe("/usr/bin/node");
    expect(capturedArgs).toEqual(["/x/node-roster.mjs", "names", "CTL-9"]);
  });

  test("filters non-string / empty entries", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify(["mini", 42, "", "mini-2"]) + "\n" });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn }).names).toEqual([
      "mini",
      "mini-2",
    ]);
  });

  test("FAIL-OPEN: non-zero exit → ok:false (never throws)", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: false,
      names: [],
    });
  });

  test("FAIL-OPEN: spawn throws → ok:false", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: false,
      names: [],
    });
  });

  test("FAIL-OPEN: unparseable stdout → ok:false", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: false,
      names: [],
    });
  });

  test("FAIL-OPEN: non-array stdout → ok:false", () => {
    const spawn = () => ({ status: 0, stdout: '{"mini":{}}\n' });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: false,
      names: [],
    });
  });

  test("FAIL-OPEN: timeout (status null) → ok:false", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    expect(readNodeNamesSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual({
      ok: false,
      names: [],
    });
  });
});

describe("registerNodeSync", () => {
  test("ok:true and forwards anchor/name/address to the CLI", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return { status: 0, stdout: JSON.stringify({ name: "mini-2", address: "h" }) + "\n" };
    };
    const r = registerNodeSync({ anchorIssue: "CTL-9", name: "mini-2", address: "h" }, { spawn });
    expect(r.ok).toBe(true);
    expect(captured).toContain("register");
    expect(captured).toContain("CTL-9");
    expect(captured).toContain("mini-2");
    expect(captured).toContain("h");
  });

  test("omits the address arg when none is given", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return { status: 0, stdout: JSON.stringify({ name: "mini", address: null }) + "\n" };
    };
    registerNodeSync({ anchorIssue: "CTL-9", name: "mini" }, { spawn });
    // [cli, register, anchor, name] — exactly 4, no trailing address
    expect(captured).toEqual([captured[0], "register", "CTL-9", "mini"]);
  });

  test("fail-open: non-zero exit → ok:false with diagnostic error", () => {
    const spawn = () => ({ status: 2, stdout: "", stderr: "Linear 401 Unauthorized\n" });
    const r = registerNodeSync({ anchorIssue: "CTL-9", name: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit 2");
    expect(r.error).toContain("401 Unauthorized");
  });

  test("fail-open: spawn throws → ok:false", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    const r = registerNodeSync({ anchorIssue: "CTL-9", name: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("EACCES");
  });
});

describe("deregisterNodeSync", () => {
  test("ok:true and surfaces { removed } from the CLI", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return { status: 0, stdout: JSON.stringify({ removed: true }) + "\n" };
    };
    const r = deregisterNodeSync({ anchorIssue: "CTL-9", name: "mini" }, { spawn });
    expect(r).toEqual({ ok: true, removed: true });
    expect(captured).toEqual([captured[0], "deregister", "CTL-9", "mini"]);
  });

  test("removed:false flows through", () => {
    const spawn = () => ({ status: 0, stdout: JSON.stringify({ removed: false }) + "\n" });
    expect(deregisterNodeSync({ anchorIssue: "CTL-9", name: "ghost" }, { spawn })).toEqual({
      ok: true,
      removed: false,
    });
  });

  test("fail-open: non-zero exit → ok:false", () => {
    const spawn = () => ({ status: 1, stdout: "", stderr: "boom" });
    const r = deregisterNodeSync({ anchorIssue: "CTL-9", name: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit 1");
  });
});
