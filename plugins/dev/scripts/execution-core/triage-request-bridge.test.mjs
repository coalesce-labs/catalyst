import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTriageHold, readTriageRequest, recordTriageDecline, recordTriageRequest, shouldEscalateTriageRequest } from "./triage-request.mjs";

let root;
afterEach(()=>{ if(root) rmSync(root,{recursive:true,force:true}); root=null; });
describe("CAT-166 triage-request bridge record",()=>{
  test("stale done survives a declined monitor sweep and becomes bounded",()=>{
    root=mkdtempSync(join(tmpdir(),"cat166-bridge-")); const worker=join(root,"workers","CAT-166"); mkdirSync(worker,{recursive:true});
    writeFileSync(join(worker,"phase-triage.json"),JSON.stringify({status:"done"}));
    const holdClass=classifyTriageHold(root,"CAT-166"); expect(holdClass).toBe("stale-done");
    recordTriageRequest(root,"CAT-166",{team:"CAT",class:holdClass,reason:"untriaged-no-triage-artifact",holdStreak:1},{now:100,hostName:"scheduler"});
    recordTriageDecline(root,"CAT-166","delegate-unreadable-ctl1174",{now:200,hostName:"monitor"});
    const request=readTriageRequest(root,"CAT-166"); expect(request.lastDecline.reason).toBe("delegate-unreadable-ctl1174");
    expect(shouldEscalateTriageRequest(request,{now:100+45*60_000,escalateMs:45*60_000})).toEqual({escalate:true,reason:"delegate-unreadable-ctl1174"});
  });
  test("in-flight signal never starts a request episode",()=>{
    root=mkdtempSync(join(tmpdir(),"cat166-bridge-")); const worker=join(root,"workers","CAT-166"); mkdirSync(worker,{recursive:true});
    writeFileSync(join(worker,"phase-triage.json"),JSON.stringify({status:"running"}));
    expect(classifyTriageHold(root,"CAT-166")).toBeNull(); expect(readTriageRequest(root,"CAT-166")).toBeNull();
  });
});
