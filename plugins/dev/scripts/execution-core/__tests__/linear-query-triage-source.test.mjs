import { test, expect } from "bun:test";
import { runTriageStateQuery } from "../linear-query.mjs";

test("no-replica branch records a skipped daemon read (CAT-35)", () => {
  const reads = [];
  runTriageStateQuery(
    { team: "CAT", triageStatus: "Triage" },
    { replica: undefined, onSource: () => {}, recordRead: (...args) => reads.push(args) },
  );
  expect(reads).toEqual([["replica", "skipped", null, null, "triage_list"]]);
});

test("replica-miss still records failed", () => {
  const reads = [];
  runTriageStateQuery(
    { team: "CAT", triageStatus: "Triage" },
    {
      replica: { triageState: () => undefined },
      onSource: () => {},
      recordRead: (...args) => reads.push(args),
    },
  );
  expect(reads[0]).toEqual(["replica", "failed", null, null, "triage_list"]);
});
