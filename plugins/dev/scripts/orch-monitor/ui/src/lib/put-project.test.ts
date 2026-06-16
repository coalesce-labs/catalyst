import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { putProject } from "./put-project";

describe("putProject", () => {
  let originalFetch: typeof globalThis.fetch;

  // Bun's mock() returns a Mock<…> that lacks fetch's `preconnect` member, so a
  // direct assignment to globalThis.fetch fails typecheck — cast through unknown once.
  const setFetch = (
    fn: (url: string | URL | Request, opts?: RequestInit) => Promise<Response>,
  ) => {
    globalThis.fetch = mock(fn) as unknown as typeof fetch;
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("PUTs to /api/projects/:key with JSON body", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit | undefined;
    setFetch(async (url, opts) => {
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
    setFetch(async (url) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    });

    await putProject("MY/KEY", { name: "Test" });
    expect(capturedUrl).toBe("/api/projects/MY%2FKEY");
  });

  it("resolves without error on a 2xx response", async () => {
    setFetch(async () => new Response("{}", { status: 200 }));
    await expect(putProject("CTL", {})).resolves.toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    setFetch(async () => new Response("unknown-key", { status: 404 }));
    await expect(putProject("BOGUS", {})).rejects.toThrow("404");
  });

  it("throws on a 500 server error", async () => {
    setFetch(async () => new Response("internal error", { status: 500 }));
    await expect(putProject("CTL", {})).rejects.toThrow("500");
  });

  it("ProjectPatch uses `color`, never `defaultColor`", async () => {
    let body: Record<string, unknown> = {};
    setFetch(async (_url, opts) => {
      body = JSON.parse(opts?.body as string);
      return new Response("{}", { status: 200 });
    });
    await putProject("CTL", { color: "lime" });
    expect(body).toEqual({ color: "lime" });
  });
});
