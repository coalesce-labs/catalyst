// host-memory.test.mjs — cross-platform "actually available" host memory.
// Run: cd plugins/dev/scripts/execution-core && bun test host-memory.test.mjs

import { describe, test, expect } from "bun:test";
import { availableMemMb, parseVmStatAvailableMb } from "./host-memory.mjs";

const SAMPLE_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   232637.
Pages active:                                1112000.
Pages inactive:                              1110471.
Pages speculative:                              6222.
Pages throttled:                                   0.
Pages wired down:                             172042.
Pages purgeable:                                3620.
"Translation faults":                    15616633287.
Pages copy-on-write:                      1273178180.
Pages zero filled:                        5851058658.
Pages reactivated:                          54484031.
Pages purged:                                7102843.
File-backed pages:                            809854.
Anonymous pages:                             1418839.
Pages stored in compressor:                   857556.
Pages occupied by compressor:                 476983.
Decompressions:                             25295203.
Compressions:                               49676828.
Pageins:                                    86459134.
Pageouts:                                     571335.
Swapins:                                           0.
Swapouts:                                          0.
`;

describe("parseVmStatAvailableMb", () => {
  test("sums free + inactive + speculative + purgeable pages, not active/wired", () => {
    // (232637 + 1110471 + 6222 + 3620) * 16384 bytes / 1024 / 1024
    const expectedMb = Math.round(((232637 + 1110471 + 6222 + 3620) * 16384) / 1024 / 1024);
    expect(parseVmStatAvailableMb(SAMPLE_VM_STAT)).toBe(expectedMb);
    expect(parseVmStatAvailableMb(SAMPLE_VM_STAT)).toBeGreaterThan(20_000); // ~21GB, not the ~3.6GB freemem() alone would report
  });

  test("falls back to a 4096-byte page size when the header is unparseable", () => {
    const text = "Pages free:                                   1024.\n";
    expect(parseVmStatAvailableMb(text)).toBe(Math.round((1024 * 4096) / 1024 / 1024));
  });

  test("malformed input yields 0, not a throw", () => {
    expect(parseVmStatAvailableMb("not vm_stat output at all")).toBe(0);
  });
});

describe("availableMemMb", () => {
  test("darwin: computes from injected vm_stat text regardless of the real host OS", () => {
    const mb = availableMemMb({
      vmStat: () => SAMPLE_VM_STAT,
      platformOverride: () => "darwin",
    });
    expect(mb).toBe(parseVmStatAvailableMb(SAMPLE_VM_STAT));
  });

  test("non-darwin: falls back to os.freemem(), never shells out to vm_stat", () => {
    let vmStatCalled = false;
    const mb = availableMemMb({
      vmStat: () => {
        vmStatCalled = true;
        return SAMPLE_VM_STAT;
      },
      platformOverride: () => "linux",
    });
    expect(vmStatCalled).toBe(false);
    expect(typeof mb).toBe("number");
  });

  test("a throwing vm_stat degrades to null, never crashes", () => {
    const mb = availableMemMb({
      vmStat: () => {
        throw new Error("vm_stat: command not found");
      },
      platformOverride: () => "darwin",
    });
    expect(mb).toBeNull();
  });
});
