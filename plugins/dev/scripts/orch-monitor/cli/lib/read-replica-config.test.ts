// read-replica-config.test.ts — CTL-1346. Exercises the Node-side Layer-2 reads
// (catalyst.readReplica.baseUrl + node class) that feed the read-replica resolver.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readReplicaBaseUrlFromLayer2, nodeClassForRead } from "./read-replica-config";

const ENV_KEYS = ["CATALYST_NODE_CLASS", "CATALYST_LAYER2_CONFIG_FILE", "HOME"];
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), "ctl1346-"));
  delete process.env.CATALYST_NODE_CLASS;
  // Point Layer-2 at a guaranteed-absent file so an ambient config never leaks in.
  process.env.CATALYST_LAYER2_CONFIG_FILE = join(tmp, "absent.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function writeLayer2(obj: unknown): void {
  const p = join(tmp, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  process.env.CATALYST_LAYER2_CONFIG_FILE = p;
}

describe("readReplicaBaseUrlFromLayer2", () => {
  it("reads a string catalyst.readReplica.baseUrl (trimmed)", () => {
    writeLayer2({ catalyst: { readReplica: { baseUrl: "  http://mini:7400  " } } });
    expect(readReplicaBaseUrlFromLayer2()).toBe("http://mini:7400");
  });

  it("returns null when the key is absent", () => {
    writeLayer2({ catalyst: { host: { name: "mini" } } });
    expect(readReplicaBaseUrlFromLayer2()).toBeNull();
  });

  it("returns null for a blank or non-string value", () => {
    writeLayer2({ catalyst: { readReplica: { baseUrl: "   " } } });
    expect(readReplicaBaseUrlFromLayer2()).toBeNull();
    writeLayer2({ catalyst: { readReplica: { baseUrl: 7400 } } });
    expect(readReplicaBaseUrlFromLayer2()).toBeNull();
  });

  it("never throws on a malformed/absent file", () => {
    const p = join(tmp, "config.json");
    writeFileSync(p, "{ not json");
    process.env.CATALYST_LAYER2_CONFIG_FILE = p;
    expect(() => readReplicaBaseUrlFromLayer2()).not.toThrow();
    expect(readReplicaBaseUrlFromLayer2()).toBeNull();
  });
});

describe("nodeClassForRead", () => {
  it("defaults to worker when nothing is set", () => {
    expect(nodeClassForRead()).toBe("worker");
  });

  it("reads CATALYST_NODE_CLASS env (trim + lowercase)", () => {
    process.env.CATALYST_NODE_CLASS = "  Developer ";
    expect(nodeClassForRead()).toBe("developer");
  });

  it("reads catalyst.node.class from Layer-2 when env is unset", () => {
    writeLayer2({ catalyst: { node: { class: "developer" } } });
    expect(nodeClassForRead()).toBe("developer");
  });

  it("env wins over Layer-2", () => {
    writeLayer2({ catalyst: { node: { class: "worker" } } });
    process.env.CATALYST_NODE_CLASS = "developer";
    expect(nodeClassForRead()).toBe("developer");
  });

  it("a present-but-invalid class resolves to monitor (most-restrictive, mirrors config.mjs)", () => {
    process.env.CATALYST_NODE_CLASS = "developr";
    expect(nodeClassForRead()).toBe("monitor");
    delete process.env.CATALYST_NODE_CLASS;
    writeLayer2({ catalyst: { node: { class: "wokrer" } } });
    expect(nodeClassForRead()).toBe("monitor");
  });

  it("a present non-string class resolves to monitor; null/blank resolve to worker", () => {
    writeLayer2({ catalyst: { node: { class: 7 } } });
    expect(nodeClassForRead()).toBe("monitor");
    writeLayer2({ catalyst: { node: { class: null } } });
    expect(nodeClassForRead()).toBe("worker");
    writeLayer2({ catalyst: { node: { class: "  " } } });
    expect(nodeClassForRead()).toBe("worker");
  });

  it("an empty CATALYST_LAYER2_CONFIG_FILE falls back to the default ~/.config path", () => {
    // os.homedir() locks to $HOME at process startup, so redirecting it needs a
    // fresh subprocess: HOME=temp + an EMPTY override must read temp/.config/...
    // (the `||` fix) rather than resolving the path to "" (the `??` bug → worker).
    const home = mkdtempSync(join(tmpdir(), "ctl1346-home-"));
    mkdirSync(join(home, ".config", "catalyst"), { recursive: true });
    writeFileSync(
      join(home, ".config", "catalyst", "config.json"),
      JSON.stringify({ catalyst: { node: { class: "developer" } } }),
    );
    const modulePath = join(import.meta.dir, "read-replica-config.ts");
    const res = spawnSync(
      "bun",
      ["-e", `const m = await import(${JSON.stringify(modulePath)}); console.log(m.nodeClassForRead());`],
      { env: { ...process.env, HOME: home, CATALYST_LAYER2_CONFIG_FILE: "" }, encoding: "utf8" },
    );
    expect(res.stdout.trim()).toBe("developer");
    rmSync(home, { recursive: true, force: true });
  });
});
