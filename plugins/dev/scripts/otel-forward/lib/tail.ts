import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

function defaultMonthPath(eventsDir: string): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(eventsDir, `${ym}.jsonl`);
}

export interface TailerOpts {
  eventsDir?: string;
  filePath?: string;
  monthFn?: () => string;
  offset: number;
  onLine: (line: string) => void;
  signal: AbortSignal;
  pollMs?: number;
  /**
   * CTL-1817: called with the raw line when it parses as a JSON object but matches NONE of
   * the three recognized envelope shapes, i.e. exactly the lines this tailer drops on the
   * floor. Optional so every existing caller is unchanged; index.ts wires it to a counter +
   * warning so the drop is loud instead of silent. See shouldForward below.
   */
  onUnrecognized?: (line: string) => void;
  /**
   * CTL-1809: called with the raw line when it does not parse as JSON at all — a TORN line,
   * i.e. the product of a bash producer's multi-write(2) append being interleaved by a
   * concurrent producer. Distinct from onUnrecognized, which fires for a line that parses
   * fine but matches no known envelope shape. Both are drops; only this one means the log
   * itself was damaged on the way in.
   *
   * Optional so every existing caller is unchanged; index.ts wires it to a counter +
   * sparse warning. See shouldForward's catch below.
   */
  onUnparseable?: (line: string) => void;
}

export interface Tailer {
  drain: () => Promise<void>;
  run: () => Promise<void>;
  currentPath: () => string;
  currentOffset: () => number;
}

export function createTailer(opts: TailerOpts): Tailer {
  const pollMs = opts.pollMs ?? 200;
  const monthFn = opts.monthFn ?? (() => defaultMonthPath(opts.eventsDir ?? ""));
  let currentPath = opts.filePath ?? monthFn();
  let offset = opts.offset;

  // Accept canonical OTel envelopes (have `attributes`), flat reap-intent
  // records (have `event` but no `attributes`), and pino operational logs
  // (have numeric `level` + string `msg`, no `event` or `attributes`).
  // processLine normalizes flat/pino records into canonical form before forwarding.
  //
  // CTL-1817: THIS IS THE DROP POINT. A "v3" line (`{name, ...payload, ts}` — no
  // `attributes`, no string `event`, not pino) matches none of the three predicates, so it
  // is filtered out HERE and never reaches processLine, let alone the OTLP mapper. Such
  // events are therefore not "forwarded degenerately" — they never leave the host at all.
  // 531 `phase.rescue.*` + 1 `phase.orphan-pr.*` were discarded this way in 2026-08 on mini,
  // and the discard was invisible: an unrecognized line is indistinguishable from no line.
  //
  // The producers no longer emit that shape, but the FILTER is what made the loss silent, so
  // a future shape drift would repeat it exactly. onUnrecognized makes the drop observable at
  // the only place that can see it. The forward/no-forward decision is deliberately
  // unchanged — this reports, it does not start forwarding shapes the pipeline cannot map.
  function shouldForward(line: string): boolean {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj !== "object" || obj === null) return false;
      const recognized =
        "attributes" in obj ||
        typeof obj.event === "string" ||
        (typeof obj.level === "number" && typeof obj.msg === "string");
      if (!recognized) {
        // Never let a reporting hook break the tail loop.
        try {
          opts.onUnrecognized?.(line);
        } catch {
          /* best-effort */
        }
      }
      return recognized;
    } catch {
      // CTL-1809: THIS IS THE TORN-LINE SEAM. Until now this catch swallowed an unparseable
      // line with no counter and no log line anywhere in the process — so a damaged event
      // log and a quiet one were byte-for-byte indistinguishable from here, which is how a
      // measured 200-fragment corpus on the monitor node went unreported for a week.
      //
      // COUNT AND SKIP. A torn line can never be forwarded (it has no readable envelope),
      // and it is permanently corrupt — parking `offset` on it would wedge this tailer, and
      // with it the whole forwarder, on damage that will never resolve. The byte cursor has
      // already advanced past it by the time we get here (readNewLines sets `offset = size`
      // before splitting), which is the same never-revisit contract every other reader on
      // this log ships.
      try {
        opts.onUnparseable?.(line);
      } catch {
        /* best-effort — a reporting hook must never break the tail loop */
      }
      return false;
    }
  }

  function readNewLines(): void {
    if (!existsSync(currentPath)) return;
    const size = statSync(currentPath).size;
    if (size < offset) {
      offset = 0;
      return;
    }
    if (size === offset) return;
    const len = size - offset;
    const fd = openSync(currentPath, "r");
    const buf = Buffer.alloc(len);
    try {
      readSync(fd, buf, 0, len, offset);
    } finally {
      closeSync(fd);
    }
    offset = size;
    const text = buf.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length > 0 && shouldForward(line)) opts.onLine(line);
    }
  }

  async function drain(): Promise<void> {
    readNewLines();
  }

  async function run(): Promise<void> {
    while (!opts.signal.aborted) {
      const expected = monthFn();
      if (expected !== currentPath) {
        currentPath = expected;
        offset = 0;
      }
      readNewLines();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        opts.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
    }
  }

  return { drain, run, currentPath: () => currentPath, currentOffset: () => offset };
}
