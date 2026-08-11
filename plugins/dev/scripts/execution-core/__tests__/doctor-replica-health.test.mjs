import { describe, expect, test } from "bun:test";
import { checkReplicaHealth, tokenAssignedInEnvFile } from "../doctor.mjs";

const errWith = (code) => { const e = new Error(code); e.code = code; return e; };

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

  // CAT-134 (Codex #3215 P2): "absent" and "unreadable" are different answers. Only the
  // first means "no markers yet"; the second means the durable alert latch could not be
  // inspected, which must not let an opted-in node exit 0.
  test("ENOENT directory stays informational", () =>
    expect(checkReplicaHealth({ readDir(){ throw errWith("ENOENT"); }, optedIn: true })[0]).toMatchObject({ status: "info" }));
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
    test(`${code} on an opted-in node FAILs rather than reporting "no markers"`, () => {
      const rec = checkReplicaHealth({ readDir(){ throw errWith(code); }, optedIn: true })[0];
      expect(rec.status).toBe("fail");
      expect(rec.detail).toContain(code);
      expect(rec.detail).not.toContain("no replica-health markers yet");
    });
  }
  test("unreadable state on an opted-OUT node stays advisory", () =>
    expect(checkReplicaHealth({ readDir(){ throw errWith("EACCES"); }, optedIn: false })[0].status).toBe("warn"));
});

// CAT-134 (Codex #3215 P1): presence probe for the launchd-visible token files. Contract:
// answers only "is this var assigned a non-empty value?", never surfaces the value.
describe("tokenAssignedInEnvFile", () => {
  const V = "CATALYST_CLOUD_TOKEN";
  test("export with single quotes", () => expect(tokenAssignedInEnvFile(`export ${V}='abc'\n`, V)).toBe(true));
  test("bare assignment, no export", () => expect(tokenAssignedInEnvFile(`${V}=abc\n`, V)).toBe(true));
  test("double quotes and leading whitespace", () => expect(tokenAssignedInEnvFile(`   export ${V}="abc"\n`, V)).toBe(true));
  test("empty value is not an assignment", () => expect(tokenAssignedInEnvFile(`export ${V}=''\n`, V)).toBe(false));
  test("bare empty value is not an assignment", () => expect(tokenAssignedInEnvFile(`${V}=\n`, V)).toBe(false));
  test("commented-out line does not count", () => expect(tokenAssignedInEnvFile(`#export ${V}=abc\n`, V)).toBe(false));
  test("a different var does not count", () => expect(tokenAssignedInEnvFile(`export OTHER_${V}=abc\n`, V)).toBe(false));
  test("last assignment wins, shell semantics", () => expect(tokenAssignedInEnvFile(`export ${V}=abc\nexport ${V}=''\n`, V)).toBe(false));
  test("last assignment wins when the later one is real", () => expect(tokenAssignedInEnvFile(`export ${V}=''\nexport ${V}=abc\n`, V)).toBe(true));
  test("non-string input is false, never a throw", () => expect(tokenAssignedInEnvFile(undefined, V)).toBe(false));
});
