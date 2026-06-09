// Type declarations for cross-node-stream.mjs (CTL-885, BFF3) — the cross-node
// live-tail SSE FAN-IN. Lets the strict TS server (server.ts) import the router +
// proxy without a TS7016 implicit-any error. Keep in sync with cross-node-stream.mjs.

/**
 * The discriminated decision the SSE route maps to a local tail, a remote proxy,
 * or a 404. Keyed by the owning node's host.name.
 */
export type TailRoute =
  | { mode: "local" }
  | { mode: "remote"; host: string; url: string }
  | { mode: "unroutable"; host: string };

/**
 * The committed cluster roster from <repoRoot>/.catalyst/hosts.json. An absent /
 * malformed / empty roster collapses to [] (the single-host default). Never throws.
 */
export function readClusterRoster(deps?: {
  env?: NodeJS.ProcessEnv;
  read?: (path: string, encoding: "utf8") => string;
}): string[];

/** Is the fleet a SINGLE host (roster absent or length ≤ 1)? The no-op gate. */
export function isSingleHost(roster: string[]): boolean;

/**
 * Decide HOW to serve the live tail for `sessionId`, keyed by the owning node's
 * host.name. Single-host (roster absent/len ≤ 1) is an identity no-op → "local".
 */
export function resolveTailRoute(args: {
  sessionId: string;
  roster: string[];
  selfHost: string;
  ownerHostForSession?: (sessionId: string) => string | null | undefined;
  hostBaseUrl?: (host: string) => string | null | undefined;
}): TailRoute;

/**
 * The cross-node TRANSPORT SEAM: map a roster host NAME to its orch-monitor base
 * URL via the optional `CATALYST_PEER_MONITORS` env map. Returns null when absent /
 * malformed / no entry (→ resolveTailRoute reports the owner `unroutable` = 404).
 */
export function resolvePeerBaseUrl(
  host: string,
  deps?: { env?: NodeJS.ProcessEnv },
): string | null;

/**
 * Fan in a REMOTE node's live tail by streaming its SSE body straight through.
 * Returns the upstream body on 2xx, or null on any non-2xx / network failure.
 */
export function proxyRemoteTail(args: {
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ReadableStream<Uint8Array> | null>;
