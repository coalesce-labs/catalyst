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
  function shouldForward(line: string): boolean {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj !== "object" || obj === null) return false;
      return (
        "attributes" in obj ||
        typeof obj.event === "string" ||
        (typeof obj.level === "number" && typeof obj.msg === "string")
      );
    } catch {
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
