// read-replica-config.test.ts — CTL-1346. Exercises the Node-side Layer-2 reads
// (catalyst.readReplica.baseUrl + node class) that feed the read-replica resolver.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReplicaBaseUrlFromLayer2, nodeClassForRead } from "./read-replica-config";

const ENV_KEYS = ["CATALYST_NODE_CLASS", "CATALYST_LAYER2_CONFIG_FILE"];
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

  it("an unrecognized class resolves to worker for read purposes (doctor flags the typo)", () => {
    process.env.CATALYST_NODE_CLASS = "developr";
    expect(nodeClassForRead()).toBe("worker");
  });
});
