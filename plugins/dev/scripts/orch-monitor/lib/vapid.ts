import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function loadOrCreateVapidKeys(path: string): VapidKeys {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).publicKey !== "string" ||
      typeof (parsed as Record<string, unknown>).privateKey !== "string"
    ) {
      throw new Error(`vapid.ts: malformed VAPID key file at ${path}`);
    }
    return parsed as VapidKeys;
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600 });
  // Explicitly chmod after write in case the process umask widened permissions.
  chmodSync(path, 0o600);
  return keys;
}
