import { describe, expect, test } from "bun:test";
import { checkReplicaHealth } from "../doctor.mjs";

const now = Date.parse("2026-08-11T12:00:00Z");
const run = (markers, over={}) => checkReplicaHealth({
  readDir: () => Object.keys(markers),
  readFile: (p) => markers[p.split("/").pop()],
  optedIn: true,
  now,
  ...over,
});
describe("checkReplicaHealth", () => {
  test("missing directory is informational", () => expect(checkReplicaHealth({readDir(){throw new Error("ENOENT")}})[0]).toMatchObject({status:"info"}));
  test("healthy markers pass", () => expect(run({"CAT.json":JSON.stringify({team:"CAT",alerting:false,lastHealthyTs:new Date(now).toISOString()})})[0]).toMatchObject({status:"pass"}));
  test("opted-in alert fails and distinguishes never healthy from regression", () => {
    const rec=run({"CAT.json":JSON.stringify({team:"CAT",alerting:true,consecutiveDegraded:9,lastHealthyTs:null}),"VAN.json":JSON.stringify({team:"VAN",alerting:true,consecutiveDegraded:4,lastHealthyTs:new Date(now-3_600_000).toISOString()})})[0];
    expect(rec.status).toBe("fail"); expect(rec.detail).toContain("CAT (9, never healthy on this node (unfinished provisioning))"); expect(rec.detail).toMatch(/VAN \(4, last healthy .* ago \(regressed\)\)/);
  });
  test("opted-out alert warns", () => expect(run({"CAT.json":JSON.stringify({team:"CAT",alerting:true,consecutiveDegraded:3})},{optedIn:false})[0].status).toBe("warn"));
  test("malformed files are named and skipped", () => { const rec=run({"bad.json":"{"})[0]; expect(rec.status).toBe("warn"); expect(rec.detail).toContain("bad.json"); });
  test("missing alerting is healthy", () => expect(run({"CAT.json":JSON.stringify({team:"CAT"})})[0].status).toBe("pass"));
});
