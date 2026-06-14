import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeWindowUrl } from "./write-window-url";

describe("writeWindowUrl (CTL-1112)", () => {
  it("writes the resolved URL (default) to the target file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1112-"));
    const out = join(dir, "window-url.txt");
    await writeWindowUrl({}, out);
    expect(readFileSync(out, "utf8").trim()).toBe("http://mini.rozich.com:7400/");
  });

  it("writes an explicit CATALYST_MONITOR_URL override (normalized)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1112-"));
    const out = join(dir, "window-url.txt");
    await writeWindowUrl({ CATALYST_MONITOR_URL: "http://localhost:7400" }, out);
    expect(readFileSync(out, "utf8").trim()).toBe("http://localhost:7400/");
  });
});
