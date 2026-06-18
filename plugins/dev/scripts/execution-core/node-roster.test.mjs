// node-roster.test.mjs — cluster ENROLLMENT channel (CTL-1273).
// Every test injects a fake GraphQL `post` so nothing touches the network.
// Mirrors cluster-heartbeat.test.mjs in structure and pattern.
import { describe, test, expect } from "bun:test";
import {
  nodeUrl,
  NODE_URL_PREFIX,
  parseNodeMetadata,
  readNodeRoster,
  readNodeNames,
  registerNode,
  deregisterNode,
  runCli,
} from "./node-roster.mjs";

async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    chunks.push(typeof s === "string" ? s : s.toString());
    return true;
  };
  try {
    const code = await fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

describe("nodeUrl", () => {
  test("namespaces per node name", () => {
    expect(nodeUrl("mini")).toBe("catalyst://node/mini");
    expect(nodeUrl("mini-2")).toBe("catalyst://node/mini-2");
  });
  test("prefix is the persistent-enrollment namespace (distinct from heartbeat)", () => {
    expect(NODE_URL_PREFIX).toBe("catalyst://node/");
  });
});

describe("parseNodeMetadata", () => {
  test("normalises a full record", () => {
    expect(parseNodeMetadata({ name: "mini", address: "mini.rozich.com" })).toEqual({
      name: "mini",
      address: "mini.rozich.com",
    });
  });
  test("missing address → null", () => {
    expect(parseNodeMetadata({ name: "mini" })).toEqual({ name: "mini", address: null });
  });
  test("missing/null metadata → all-null record", () => {
    expect(parseNodeMetadata(undefined)).toEqual({ name: null, address: null });
    expect(parseNodeMetadata(null)).toEqual({ name: null, address: null });
  });
  test("non-string / empty values are nulled", () => {
    expect(parseNodeMetadata({ name: 42, address: "" })).toEqual({ name: null, address: null });
  });
});

describe("readNodeRoster", () => {
  test("returns one entry per node attachment, keyed by name", async () => {
    const post = async () => ({
      issue: {
        attachments: {
          nodes: [
            {
              id: "a1",
              url: "catalyst://node/mini",
              metadata: { name: "mini", address: "mini.rozich.com" },
            },
            {
              id: "a2",
              url: "catalyst://node/mini-2",
              metadata: { name: "mini-2", address: "mini-2.rozich.com" },
            },
            // heartbeat (transient) records are NOT enrollment — must be ignored
            { id: "h1", url: "catalyst://heartbeat/mini", metadata: { host: "mini" } },
            { id: "x1", url: "https://github.com/x/y/pull/1", metadata: {} },
          ],
        },
      },
    });
    const map = await readNodeRoster({ anchorIssue: "CTL-9999" }, { post });
    expect(Object.keys(map).sort()).toEqual(["mini", "mini-2"]);
    expect(map.mini.address).toBe("mini.rozich.com");
    expect(map["mini-2"].address).toBe("mini-2.rozich.com");
  });

  test("FAIL-OPEN: a post error returns {} (never throws → never mass-evicts)", async () => {
    const post = async () => {
      throw new Error("network error");
    };
    expect(await readNodeRoster({ anchorIssue: "CTL-9999" }, { post })).toEqual({});
  });

  test("missing anchor / empty attachments → {}", async () => {
    expect(await readNodeRoster({ anchorIssue: "CTL-9999" }, { post: async () => ({}) })).toEqual(
      {}
    );
    expect(
      await readNodeRoster(
        { anchorIssue: "CTL-9999" },
        { post: async () => ({ issue: { attachments: { nodes: [] } } }) }
      )
    ).toEqual({});
  });

  test("skips a node attachment whose metadata has no name", async () => {
    const post = async () => ({
      issue: { attachments: { nodes: [{ id: "a1", url: "catalyst://node/ghost", metadata: {} }] } },
    });
    expect(await readNodeRoster({ anchorIssue: "CTL-9999" }, { post })).toEqual({});
  });
});

describe("readNodeNames", () => {
  test("returns sorted, deterministic node names", async () => {
    const post = async () => ({
      issue: {
        attachments: {
          nodes: [
            { id: "a2", url: "catalyst://node/mini-2", metadata: { name: "mini-2" } },
            { id: "a1", url: "catalyst://node/mini", metadata: { name: "mini" } },
          ],
        },
      },
    });
    expect(await readNodeNames({ anchorIssue: "CTL-9999" }, { post })).toEqual(["mini", "mini-2"]);
  });

  test("FAIL-OPEN: a post error returns []", async () => {
    const post = async () => {
      throw new Error("boom");
    };
    expect(await readNodeNames({ anchorIssue: "CTL-9999" }, { post })).toEqual([]);
  });
});

describe("registerNode", () => {
  test("upserts the per-node attachment with name + address", async () => {
    const calls = [];
    const post = async (q, v) => {
      calls.push({ q, v });
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-anchor" } };
      return { attachmentCreate: { success: true, attachment: { id: "a1" } } };
    };
    const rec = await registerNode(
      { anchorIssue: "CTL-9999", name: "mini-2", address: "mini-2.rozich.com" },
      { post }
    );
    expect(rec).toEqual({ name: "mini-2", address: "mini-2.rozich.com" });
    const write = calls.find((c) => c.q.includes("attachmentCreate"));
    expect(write.v.input.url).toBe("catalyst://node/mini-2");
    expect(write.v.input.metadata).toEqual({ name: "mini-2", address: "mini-2.rozich.com" });
    expect(write.v.input.title).toBe("catalyst-node");
  });

  test("address defaults to null when omitted", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const rec = await registerNode({ anchorIssue: "CTL-9999", name: "mini" }, { post });
    expect(rec).toEqual({ name: "mini", address: null });
  });

  // CTL-1255 regression guard: resolve MUST use issue(id:), not issues(filter:{identifier}).
  test("resolve query targets issue(id:) and reads issue.id (not issues.nodes)", async () => {
    let resolveQ = "";
    const post = async (q) => {
      if (q.includes("issue(id:") && !q.includes("attachmentCreate")) {
        resolveQ = q;
        return { issue: { id: "uuid-anchor" } };
      }
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    await registerNode({ anchorIssue: "CTL-9999", name: "mini" }, { post });
    expect(resolveQ).toContain("issue(id: $id)");
    expect(resolveQ).not.toContain("identifier");
  });

  test("throws when the anchor issue cannot be resolved", async () => {
    const post = async () => ({ issue: null });
    await expect(registerNode({ anchorIssue: "CTL-9999", name: "mini" }, { post })).rejects.toThrow(
      /no issue found/
    );
  });

  test("throws when attachmentCreate returns success:false", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: false } };
    };
    await expect(registerNode({ anchorIssue: "CTL-9999", name: "mini" }, { post })).rejects.toThrow(
      /success=false/
    );
  });

  test("throws when name is missing", async () => {
    await expect(
      registerNode({ anchorIssue: "CTL-9999", name: "" }, { post: async () => ({}) })
    ).rejects.toThrow(/requires a name/);
  });
});

describe("deregisterNode", () => {
  test("finds the attachment by url and deletes it by id", async () => {
    const calls = [];
    const post = async (q, v) => {
      calls.push({ q, v });
      if (q.includes("ReadNodes")) {
        return {
          issue: {
            attachments: {
              nodes: [
                { id: "a1", url: "catalyst://node/mini", metadata: { name: "mini" } },
                { id: "a2", url: "catalyst://node/mini-2", metadata: { name: "mini-2" } },
              ],
            },
          },
        };
      }
      return { attachmentDelete: { success: true } };
    };
    const res = await deregisterNode({ anchorIssue: "CTL-9999", name: "mini-2" }, { post });
    expect(res).toEqual({ removed: true });
    const del = calls.find((c) => c.q.includes("attachmentDelete"));
    expect(del.v.id).toBe("a2");
  });

  test("idempotent: removing an absent node returns { removed: false } (no delete call)", async () => {
    const calls = [];
    const post = async (q, v) => {
      calls.push({ q, v });
      if (q.includes("ReadNodes")) {
        return {
          issue: {
            attachments: {
              nodes: [{ id: "a1", url: "catalyst://node/mini", metadata: { name: "mini" } }],
            },
          },
        };
      }
      return { attachmentDelete: { success: true } };
    };
    const res = await deregisterNode({ anchorIssue: "CTL-9999", name: "ghost" }, { post });
    expect(res).toEqual({ removed: false });
    expect(calls.some((c) => c.q.includes("attachmentDelete"))).toBe(false);
  });

  test("throws when attachmentDelete returns success:false", async () => {
    const post = async (q) => {
      if (q.includes("ReadNodes")) {
        return {
          issue: {
            attachments: {
              nodes: [{ id: "a1", url: "catalyst://node/mini", metadata: { name: "mini" } }],
            },
          },
        };
      }
      return { attachmentDelete: { success: false } };
    };
    await expect(
      deregisterNode({ anchorIssue: "CTL-9999", name: "mini" }, { post })
    ).rejects.toThrow(/success=false/);
  });

  test("throws when name is missing", async () => {
    await expect(
      deregisterNode({ anchorIssue: "CTL-9999", name: "" }, { post: async () => ({}) })
    ).rejects.toThrow(/requires a name/);
  });
});

describe("runCli", () => {
  test("read: prints JSON map and exits 0", async () => {
    const post = async () => ({
      issue: {
        attachments: {
          nodes: [
            { id: "a1", url: "catalyst://node/mini", metadata: { name: "mini", address: "h" } },
          ],
        },
      },
    });
    const { code, out } = await captureStdout(() => runCli(["read", "CTL-9999"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out).mini).toEqual({ name: "mini", address: "h" });
  });

  test("names: prints sorted JSON array and exits 0", async () => {
    const post = async () => ({
      issue: {
        attachments: {
          nodes: [
            { id: "a2", url: "catalyst://node/mini-2", metadata: { name: "mini-2" } },
            { id: "a1", url: "catalyst://node/mini", metadata: { name: "mini" } },
          ],
        },
      },
    });
    const { code, out } = await captureStdout(() => runCli(["names", "CTL-9999"], { post }));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(["mini", "mini-2"]);
  });

  test("register: prints the JSON record and exits 0", async () => {
    const post = async (q) => {
      if (q.includes("ResolveIssue")) return { issue: { id: "uuid-x" } };
      return { attachmentCreate: { success: true, attachment: {} } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["register", "CTL-9999", "mini-2", "mini-2.rozich.com"], { post })
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ name: "mini-2", address: "mini-2.rozich.com" });
  });

  test("deregister: prints { removed } and exits 0", async () => {
    const post = async (q) => {
      if (q.includes("ReadNodes")) {
        return {
          issue: {
            attachments: {
              nodes: [{ id: "a1", url: "catalyst://node/mini", metadata: { name: "mini" } }],
            },
          },
        };
      }
      return { attachmentDelete: { success: true } };
    };
    const { code, out } = await captureStdout(() =>
      runCli(["deregister", "CTL-9999", "mini"], { post })
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ removed: true });
  });

  test("unknown subcommand exits 1", async () => {
    const { code } = await captureStdout(() => runCli(["bogus"], {}));
    expect(code).toBe(1);
  });
});
