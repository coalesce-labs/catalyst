import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function loadOrCreateVapidKeys(path: string): VapidKeys {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
  }
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600 });
  // Explicitly chmod after write in case the process umask widened permissions.
  chmodSync(path, 0o600);
  return keys;
}
