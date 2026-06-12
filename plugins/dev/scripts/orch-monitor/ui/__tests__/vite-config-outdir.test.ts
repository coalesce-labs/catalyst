import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "path";

afterEach(() => {
  delete process.env.MONITOR_UI_DIST_DIR;
});

describe("vite outDir", () => {
  it("uses MONITOR_UI_DIST_DIR when set", async () => {
    process.env.MONITOR_UI_DIST_DIR = "/tmp/catalyst-dist-test";
    const { OUT_DIR } = await import(`../vite.config.ts?t=${performance.now()}`);
    expect(OUT_DIR).toBe("/tmp/catalyst-dist-test");
  });

  it("falls back to the committed ../public when unset", async () => {
    delete process.env.MONITOR_UI_DIST_DIR;
    const { OUT_DIR } = await import(`../vite.config.ts?t=${performance.now()}`);
    expect(OUT_DIR).toBe(resolve(__dirname, "../../public"));
  });
});
