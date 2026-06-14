import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveMonitorUrl, type MonitorUrlEnv } from "./monitor-url";

const DEFAULT_OUT = new URL("../src-tauri/gen/window-url.txt", import.meta.url).pathname;

export async function writeWindowUrl(env: MonitorUrlEnv, outPath: string): Promise<string> {
  const url = resolveMonitorUrl(env);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${url}\n`, "utf8");
  return url;
}

if (import.meta.main) {
  const url = await writeWindowUrl(process.env, DEFAULT_OUT);
  console.info(`[orch-monitor desktop] window URL → ${url}`);
}
