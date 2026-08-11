import { describe, test, expect } from "bun:test";
import { checkAppActorMint, checksForClass, parseArgs } from "../doctor.mjs";

const SECRET = "lin_oauth_SENTINELSENTINEL";
const LAYER2 = "/tmp/catalyst-test-config.json";
const ACTORS = {
  orchestrator: { clientId: "client-orch", clientSecret: "secret-orch", botUserId: "user-orch" },
  linearis: { clientId: "client-linearis", clientSecret: "secret-linearis", botUserId: "user-linearis" },
};

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function healthyFetch(calls = []) {
  let lastClientId = null;
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/oauth/token")) {
      lastClientId = options.body.get("client_id");
      return response(200, { access_token: SECRET });
    }
    const isLinearis = lastClientId === "client-linearis";
    return response(200, { data: { viewer: {
      id: isLinearis ? "user-linearis" : "user-orch",
      email: isLinearis ? "linearis@example.com" : "orchestrator@example.com",
    } } });
  };
}

function deps(over = {}) {
  return { readBotConfig: () => ACTORS, layer2Path: LAYER2, fetch: healthyFetch(), ...over };
}

describe("checkAppActorMint", () => {
  test("mints and verifies every configured actor independently", async () => {
    const calls = [];
    const records = await checkAppActorMint(deps({ fetch: healthyFetch(calls) }));
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.name)).toEqual(["app-actor:linearis", "app-actor:orchestrator"]);
    expect(records.every((r) => r.status === "pass")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("@example.com");
    for (const call of calls.filter(({ url }) => url.endsWith("/oauth/token"))) {
      expect(call.options.body.get("actor")).toBe("app");
      expect(call.options.body.get("scope")).toBe("read,write,comments:create,app:assignable,app:mentionable");
    }
  });

  test("a rejected mint FAILs that actor without short-circuiting the others", async () => {
    const healthy = healthyFetch();
    const fetch = async (url, options) => {
      if (url.endsWith("/oauth/token") && options.body.get("client_id") === "client-linearis")
        return response(401, {});
      return healthy(url, options);
    };
    const records = await checkAppActorMint(deps({ fetch }));
    const failed = records.find((r) => r.name === "app-actor:linearis");
    expect(failed.status).toBe("fail");
    expect(failed.detail).toContain("catalyst.linear.bot.linearis.clientSecret");
    expect(failed.detail).toContain(LAYER2);
    expect(records.find((r) => r.name === "app-actor:orchestrator").status).toBe("pass");
  });

  test("viewer identity mismatch FAILs and names both ids", async () => {
    const fetch = async (url) => url.endsWith("/oauth/token")
      ? response(200, { access_token: SECRET })
      : response(200, { data: { viewer: { id: "wrong-user", email: "wrong@example.com" } } });
    const [record] = await checkAppActorMint(deps({ readBotConfig: () => ({ linearis: ACTORS.linearis }), fetch }));
    expect(record.status).toBe("fail");
    expect(record.detail).toContain("wrong-user");
    expect(record.detail).toContain("user-linearis");
  });

  test("incomplete credentials FAIL without making a network call", async () => {
    let calls = 0;
    const [record] = await checkAppActorMint(deps({
      readBotConfig: () => ({ linearis: { clientId: "client-linearis", botUserId: "user-linearis" } }),
      fetch: async () => { calls++; },
    }));
    expect(record.status).toBe("fail");
    expect(calls).toBe(0);
  });

  test("no configured app actors is a single INFO", async () => {
    const records = await checkAppActorMint(deps({ readBotConfig: () => ({}) }));
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("info");
    expect(records[0].detail).toMatch(/no app-actors configured.*nothing to verify/i);
  });

  test("transport errors FAIL with the error but never a credential", async () => {
    const [record] = await checkAppActorMint(deps({
      readBotConfig: () => ({ linearis: { ...ACTORS.linearis, clientSecret: SECRET } }),
      fetch: async () => { throw new Error("network down"); },
    }));
    expect(record.status).toBe("fail");
    expect(record.detail).toContain("network down");
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  test("minted access token never leaks into any record", async () => {
    let calls = 0;
    const records = await checkAppActorMint(deps({
      readBotConfig: () => ({ linearis: { ...ACTORS.linearis, clientSecret: "client-secret-sentinel" } }),
      fetch: async () => {
        calls++;
        if (calls === 1) return response(200, { access_token: SECRET });
        throw new Error(`transport rejected ${SECRET} and client-secret-sentinel`);
      },
    }));
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(JSON.stringify(records)).not.toContain("client-secret-sentinel");
    expect(records[0].detail).toContain("transport rejected");
  });
});

describe("--verify-app-actors wiring", () => {
  const worker = { recognized: true, class: "worker" };
  const developer = { recognized: true, class: "developer" };
  const monitor = { recognized: true, class: "monitor" };

  test("is absent from the default worker suite", () => {
    const source = checksForClass(worker).map((fn) => fn.toString()).join("\n");
    expect(source).not.toContain("checkAppActorMint");
  });

  test("parses the flag and adds the verifier for every node class only when requested", () => {
    expect(parseArgs([]).verifyAppActors).toBe(false);
    expect(parseArgs(["--verify-app-actors"]).verifyAppActors).toBe(true);
    for (const nodeClass of [worker, developer, monitor]) {
      const defaultSource = checksForClass(nodeClass).map((fn) => fn.toString()).join("\n");
      const requestedSource = checksForClass(nodeClass, { verifyAppActors: true })
        .map((fn) => fn.toString()).join("\n");
      expect(defaultSource).not.toContain("checkAppActorMint");
      expect(requestedSource).toContain("checkAppActorMint");
    }
  });
});
