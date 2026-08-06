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
  /** Feed one line. Returns false when the sink is backpressured (jq stdin buffer
   *  full) — the caller should `await drain()` before writing more so a large
   *  chunked scan stays memory-bounded (CTL-1515). */
  write(line: string): boolean;
  /** Resolve once the sink is writable again (or immediately if not backpressured). */
  drain(): Promise<void>;
  /** Wait briefly for any in-flight stdout to drain. */
  flush(): Promise<void>;
  /** End input and resolve once the filter has emitted ALL output (jq exited) — so a
   *  caller reading accumulated matches sees every one, not just what a fixed-delay
   *  flush happened to capture (CTL-1515). */
  end(): Promise<void>;
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
      '{"ts":"","id":"00000000-0000-4000-8000-000000000000","observedTs":"","severityText":"INFO","severityNumber":9,"traceId":null,"spanId":null,"resource":{"service.name":"","service.namespace":"catalyst","service.version":"","catalyst.node.class":""},"attributes":{"event.name":""},"body":{}}';
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
      write(line: string): boolean {
        if (closed || !cb) return true;
        try {
          JSON.parse(line);
          cb(line);
        } catch {
          /* drop invalid JSON */
        }
        return true; // synchronous passthrough — never backpressured
      },
      drain(): Promise<void> {
        return Promise.resolve();
      },
      flush(): Promise<void> {
        return Promise.resolve();
      },
      end(): Promise<void> {
        return Promise.resolve(); // synchronous passthrough — all output already emitted
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
    write(line: string): boolean {
      if (closed) return true;
      // Pre-validate JSON; jq dies on invalid input so we drop bad lines here
      // (matches the CLI's `2>/dev/null` behavior).
      try {
        JSON.parse(line);
      } catch {
        return true;
      }
      try {
        // Return jq stdin's backpressure signal so a chunked scan can await
        // drain() and stay memory-bounded (CTL-1515).
        return proc.stdin?.write(line + "\n") ?? true;
      } catch {
        return true; // broken pipe — don't ask the caller to wait
      }
    },
    drain(): Promise<void> {
      const s = proc.stdin;
      if (closed || !s || !s.writableNeedDrain) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          s.off("error", done);
          resolve();
        };
        s.once("drain", done);
        s.once("error", done); // never hang on a broken pipe
      });
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
    end(): Promise<void> {
      // End jq's stdin and resolve once it has flushed all output and exited, so a
      // caller reading accumulated matches sees EVERY match — not just what the
      // fixed 50ms flush happened to capture on a large log (CTL-1515). The stdout
      // 'data' handler above drains all output before 'close' fires.
      if (closed) return Promise.resolve();
      // If jq already exited (e.g. a `halt`-style predicate terminated it before
      // end() was called), its 'close' has already fired and won't fire again —
      // resolve immediately instead of waiting forever (Codex P2 on #2730).
      if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        proc.once("close", finish);
        proc.once("error", finish); // never hang on a spawn/pipe error
        try {
          proc.stdin?.end();
        } catch {
          finish();
        }
      });
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
