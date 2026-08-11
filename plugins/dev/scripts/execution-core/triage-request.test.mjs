import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyTriageHold, clearTriageRequest, isTriageInFlight, listTriageRequests,
  readTriageRequest, readTriageSignalStatus, reapStaleTriageRequests,
  recordTriageDecline, recordTriageRequest, shouldEscalateTriageRequest,
} from "./triage-request.mjs";

const dirs = [];
const fixture = () => { const d = mkdtempSync(join(tmpdir(), "cat166-")); dirs.push(d); return d; };
const worker = (d, t = "CAT-166") => { const p = join(d, "workers", t); mkdirSync(p, { recursive: true }); return p; };
afterEach(() => { for (const d of dirs.splice(0)) { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); } });

describe("triage request leaf", () => {
  test("signal reader fails open and in-flight classifier is exact", () => {
    const d = fixture(); const w = worker(d);
    expect(readTriageSignalStatus(d, "CAT-166")).toBeNull();
    writeFileSync(join(w, "phase-triage.json"), "{"); expect(readTriageSignalStatus(d, "CAT-166")).toBeNull();
    for (const status of ["done", "dispatched", "running", "pending", "failed", "stalled"]) {
      writeFileSync(join(w, "phase-triage.json"), JSON.stringify({ status }));
      expect(readTriageSignalStatus(d, "CAT-166")).toBe(status);
      expect(isTriageInFlight(status)).toBe(["dispatched", "running", "pending"].includes(status));
    }
  });
  test("classifies hold without requesting in-flight work", () => {
    const d = fixture(); const w = worker(d);
    expect(classifyTriageHold(d, "CAT-166")).toBe("untriaged");
    writeFileSync(join(w, "phase-triage.json"), JSON.stringify({ status: "done" }));
    expect(classifyTriageHold(d, "CAT-166")).toBe("stale-done");
    for (const status of ["dispatched", "running", "pending"]) {
      writeFileSync(join(w, "phase-triage.json"), JSON.stringify({ status }));
      expect(classifyTriageHold(d, "CAT-166")).toBeNull();
    }
    writeFileSync(join(w, "phase-triage.json"), JSON.stringify({ status: "failed" }));
    expect(classifyTriageHold(d, "CAT-166")).toBe("settled-no-artifact");
  });
  test("writes the literal record shape and preserves episode state", () => {
    const d = fixture();
    const first = recordTriageRequest(d, "CAT-166", { team: "CAT", class: "untriaged", reason: "hold", holdStreak: 1 }, { now: 100, hostName: "h1" });
    expect(JSON.parse(readFileSync(join(d, ".triage-requests", "CAT-166.json"), "utf8"))).toEqual({ ticket:"CAT-166", team:"CAT", class:"untriaged", reason:"hold", firstRequestedAt:100, lastRequestedAt:100, holdStreak:1, requestedByHost:"h1", lastDecline:null, escalatedAt:null });
    recordTriageDecline(d, "CAT-166", "drain-active", { now: 150, hostName: "h2" });
    const second = recordTriageRequest(d, "CAT-166", { team:"CAT", class:"untriaged", reason:"hold", holdStreak:2 }, { now:200, hostName:"h1" });
    expect(second.firstRequestedAt).toBe(first.firstRequestedAt); expect(second.lastDecline.reason).toBe("drain-active");
  });
  test("decline changes only on reason and absent request is a no-op", () => {
    const d = fixture(); expect(recordTriageDecline(d,"NONE-1","drain-active")).toEqual({changed:false});
    recordTriageRequest(d,"CAT-166",{team:"CAT",class:"untriaged",reason:"hold",holdStreak:1},{now:1,hostName:"h"});
    expect(recordTriageDecline(d,"CAT-166","drain-active",{now:2,hostName:"h"}).changed).toBe(true);
    expect(recordTriageDecline(d,"CAT-166","drain-active",{now:3,hostName:"h"}).changed).toBe(false);
  });
  test("repairs malformed records, normalizes team, lists, clears, and reaps", () => {
    const d=fixture(); mkdirSync(join(d,".triage-requests")); writeFileSync(join(d,".triage-requests","CAT-166.json"),"{");
    expect(readTriageRequest(d,"CAT-166")).toBeNull();
    recordTriageRequest(d,"CAT-166",{team:"",class:"untriaged",reason:"hold",holdStreak:1},{now:1,hostName:"h"});
    expect(readTriageRequest(d,"CAT-166").team).toBeNull(); expect(listTriageRequests(d)).toHaveLength(1);
    expect(reapStaleTriageRequests(d,{ttlMs:5,now:7})).toEqual(["CAT-166"]);
    expect(clearTriageRequest(d,"CAT-166")).toBe(false);
  });
  test("escalation is age- and episode-bounded", () => {
    const base={firstRequestedAt:10,lastDecline:null,escalatedAt:null};
    expect(shouldEscalateTriageRequest(base,{now:14,escalateMs:5})).toEqual({escalate:false,reason:"never-considered"});
    expect(shouldEscalateTriageRequest(base,{now:15,escalateMs:5})).toEqual({escalate:true,reason:"never-considered"});
    expect(shouldEscalateTriageRequest({...base,escalatedAt:12},{now:20,escalateMs:5}).escalate).toBe(false);
  });
});
