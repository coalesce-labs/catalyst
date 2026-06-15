import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { putProject } from "./put-project";

describe("putProject", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("PUTs to /api/projects/:key with JSON body", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit | undefined;
    globalThis.fetch = mock(async (url: string | URL | Request, opts?: RequestInit) => {
      capturedUrl = String(url);
      capturedOpts = opts;
      return new Response("{}", { status: 200 });
    });

    await putProject("CTL", { name: "Catalyst" });

    expect(capturedUrl).toBe("/api/projects/CTL");
    expect(capturedOpts?.method).toBe("PUT");
    expect(capturedOpts?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(capturedOpts?.body as string)).toEqual({ name: "Catalyst" });
  });

  it("encodes special characters in the key", async () => {
    let capturedUrl = "";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    });

    await putProject("MY/KEY", { name: "Test" });
    expect(capturedUrl).toBe("/api/projects/MY%2FKEY");
  });

  it("resolves without error on a 2xx response", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 }));
    await expect(putProject("CTL", {})).resolves.toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    globalThis.fetch = mock(async () => new Response("unknown-key", { status: 404 }));
    await expect(putProject("BOGUS", {})).rejects.toThrow("404");
  });

  it("throws on a 500 server error", async () => {
    globalThis.fetch = mock(async () => new Response("internal error", { status: 500 }));
    await expect(putProject("CTL", {})).rejects.toThrow("500");
  });
});
