import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyLabel, classifyLabelFailure } from "../linear-write.mjs";
import { labelCooldownPath, labelMarkerBase, labelOnce } from "../label-guard.mjs";

const dirs=[]; afterEach(() => { for (const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); });
describe("circuit-open label backoff", () => {
  test("classification and propagation", () => {
    expect(classifyLabelFailure("circuit-open")).toBe("circuit-open");
    expect(applyLabel({ ticket:"CAT-134", label:"blocked", exec:()=>({code:1,stderr:"circuit-open",retryAfterMs:1234}) })).toEqual({applied:false,reason:"circuit-open",retryAfterMs:1234});
  });
  test("labelOnce cooldown is non-terminal", () => {
    const dir=mkdtempSync(`${tmpdir()}/cat-134-`); dirs.push(dir); mkdirSync(`${dir}/workers/CAT-134`,{recursive:true}); let calls=0; let t=1000;
    const writeStatus={applyLabel(){ calls++; return calls===1?{applied:false,reason:"circuit-open",retryAfterMs:100}:{applied:true}; }};
    labelOnce(dir,"CAT-134","blocked",writeStatus,{now:()=>t});
    const base=labelMarkerBase(dir,"CAT-134","blocked");
    expect(existsSync(`${base}.applied`)).toBe(false); expect(existsSync(`${base}.skipped`)).toBe(false);
    expect(existsSync(labelCooldownPath(dir,"CAT-134","blocked"))).toBe(true);
    labelOnce(dir,"CAT-134","blocked",writeStatus,{now:()=>t+50}); expect(calls).toBe(1);
    labelOnce(dir,"CAT-134","blocked",writeStatus,{now:()=>t+101}); expect(calls).toBe(2); expect(existsSync(`${base}.applied`)).toBe(true);
  });
});
