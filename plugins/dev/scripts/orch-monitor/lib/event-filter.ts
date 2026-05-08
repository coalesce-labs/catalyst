/**
 * jq-based predicate filter for the global event log.
 *
 * Mirrors the semantics of `catalyst-events tail --filter <jq>` which wraps a
 * caller-provided predicate in `select(...)` and shells out to `jq -c
 * --unbuffered`. We use the same wrapping so the CLI and the orch-monitor
 * server agree on filter semantics.
 *
 * Why subprocess instead of a TS-native jq: the CLI already shells out, and a
 * TS-native jq would diverge in subtle ways (string parsing, null handling,
 * etc.). Each connected SSE client gets one long-lived `jq` process for the
 * lifetime of its subscription.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export interface FilterStream {
  write(line: string): void;
  /** Wait briefly for any in-flight stdout to drain. */
  flush(): Promise<void>;
  close(): void;
  onMatch(cb: (line: string) => void): void;
}

/**
 * Validate a predicate by running `jq -e "select(<pred>) | true" <<< '{}'` once
 * synchronously. Catches syntax errors before opening a long-lived stream.
 */
export function validatePredicate(predicate: string): ValidationResult {
  if (!predicate.trim()) return { ok: false, error: "empty predicate" };
  try {
    // Compile-check by feeding a representative event envelope and running the
    // predicate inside a try/catch so runtime errors (e.g. `startswith` on a
    // missing field) don't masquerade as compile errors. We only reject exit
    // codes 2 (usage) and 3 (compile error). Exits 0/1/4 all mean "valid
    // syntax" (matched / no-match / no-output-with-exit-status).
    // CTL-300: canonical OTel-shaped envelope. Field validation must use the
    // same shape producers emit, so jq predicates referencing canonical paths
    // (.attributes."event.name", .body.payload, etc) compile cleanly.
    const sample =
      '{"ts":"","observedTs":"","severityText":"INFO","severityNumber":9,"traceId":null,"spanId":null,"resource":{"service.name":"","service.namespace":"catalyst","service.version":""},"attributes":{"event.name":""},"body":{}}';
    const r = Bun.spawnSync({
      cmd: [
        "jq",
        "-e",
        `try (select(${predicate})) catch empty | true`,
      ],
      stdin: new TextEncoder().encode(sample + "\n"),
      stderr: "pipe",
      stdout: "pipe",
    });
    if (r.exitCode === 2 || r.exitCode === 3) {
      const stderr = new TextDecoder().decode(r.stderr ?? new Uint8Array());
      return {
        ok: false,
        error: `jq compile error: ${stderr.trim() || `exit ${r.exitCode}`}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Open a long-lived stream that pipes JSON lines into a `jq` subprocess and
 * emits matching lines via `onMatch`. Empty predicate is a JSON-validation
 * passthrough (parses each line, drops invalid JSON, emits everything else).
 */
export function createFilterStream(predicate: string): FilterStream {
  if (!predicate.trim()) {
    let cb: ((line: string) => void) | null = null;
    let closed = false;
    return {
      write(line: string): void {
        if (closed || !cb) return;
        try {
          JSON.parse(line);
          cb(line);
        } catch {
          /* drop invalid JSON */
        }
      },
      flush(): Promise<void> {
        return Promise.resolve();
      },
      close(): void {
        closed = true;
        cb = null;
      },
      onMatch(c: (line: string) => void): void {
        cb = c;
      },
    };
  }

  const proc: ChildProcess = spawn(
    "jq",
    ["-c", "--unbuffered", `select(${predicate})`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  let cb: ((line: string) => void) | null = null;
  let buf = "";
  let closed = false;
  let pendingFlush: Promise<void> | null = null;

  proc.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    if (cb) {
      for (const l of lines) {
        if (l) cb(l);
      }
    }
  });
  proc.stderr?.on("data", () => {
    /* silenced — matches CLI's `2>/dev/null` */
  });
  proc.on("error", () => {
    closed = true;
  });

  return {
    write(line: string): void {
      if (closed) return;
      // Pre-validate JSON; jq dies on invalid input so we drop bad lines here
      // (matches the CLI's `2>/dev/null` behavior).
      try {
        JSON.parse(line);
      } catch {
        return;
      }
      try {
        proc.stdin?.write(line + "\n");
      } catch {
        /* ignore broken pipe */
      }
    },
    flush(): Promise<void> {
      if (pendingFlush) return pendingFlush;
      pendingFlush = new Promise<void>((resolve) => {
        // Give jq a brief window to emit any buffered output. 50ms is enough
        // for typical line volumes; tests tolerate some jitter via additional
        // flush calls.
        setTimeout(() => {
          pendingFlush = null;
          resolve();
        }, 50);
      });
      return pendingFlush;
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        proc.stdin?.end();
      } catch {
        /* ignore */
      }
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
    onMatch(c: (line: string) => void): void {
      cb = c;
    },
  };
}
