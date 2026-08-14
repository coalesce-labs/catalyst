// no-replica.ts — CTL-1806 test helper.
//
// The supplemental resolvers are now REPLICA-FIRST, gated on file presence at
// `CATALYST_REPLICA_DB || $CATALYST_DIR/catalyst-replica.db`. Every pre-existing
// test in this directory asserts the DEGRADED (Linear GraphQL) behaviour, and a
// developer machine HAS a real `~/catalyst/catalyst-replica.db` while CI does
// not — so without an explicit pin those tests silently exercise a different
// code path locally than in CI, passing in CI and failing (or worse, passing for
// the wrong reason) on a laptop. That is the exact "green in CI, different
// mechanism on a dev box" flake class this repo has been bitten by before.
//
// pinNoReplica() forces the file-presence gate CLOSED for the duration of a test
// file, so the Linear tier is genuinely reached. Call it in beforeAll and call
// the returned restore fn in afterAll.
//
// It deliberately does NOT stub the reader: pointing at a path that does not
// exist exercises the REAL gate, so a regression that removes the gate is caught
// here rather than hidden by a fake.
export function pinNoReplica(): () => void {
  const prevDb = process.env.CATALYST_REPLICA_DB;
  const prevDir = process.env.CATALYST_DIR;
  // A path under a directory that cannot exist — never merely "unlikely".
  process.env.CATALYST_REPLICA_DB =
    "/nonexistent-ctl-1806/no-such-dir/catalyst-replica.db";
  return () => {
    if (prevDb !== undefined) process.env.CATALYST_REPLICA_DB = prevDb;
    else delete process.env.CATALYST_REPLICA_DB;
    if (prevDir !== undefined) process.env.CATALYST_DIR = prevDir;
    else delete process.env.CATALYST_DIR;
  };
}
