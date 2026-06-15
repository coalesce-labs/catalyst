// CTL-1167: React hook for PWA Web Push subscription lifecycle.
//
// Feature-detects Notification + serviceWorker + PushManager, prompts once for
// permission on an explicit user gesture (enable()), subscribes via the VAPID
// key fetched from /api/notifications/vapid-public-key, and POSTs the serialised
// PushSubscription to /api/notifications/subscribe.
//
// iOS 16.4+ home-screen installs: push works only from the installed PWA — a
// plain Safari tab lacks PushManager. The supported flag surfaces this to the UI
// so the "Enable notifications" control can be hidden on plain-tab visits.
import { useState, useCallback } from "react";

// ── Feature detection ─────────────────────────────────────────────────────────

// Evaluated once at module load (not per render) so it's a stable constant.
// false in the bun test environment (no Notification / serviceWorker / PushManager).
export const PUSH_SUPPORTED: boolean =
  typeof window !== "undefined" &&
  "Notification" in window &&
  "serviceWorker" in navigator &&
  "PushManager" in window;

// ── base64url → Uint8Array helper (for applicationServerKey) ─────────────────

// Co-located with the hook; not exported from the barrel so knip is satisfied
// by the test import.
export function base64UrlToUint8Array(base64UrlString: string): Uint8Array {
  // base64url → base64: replace URL-safe chars, then pad to a multiple of 4.
  const base64 = base64UrlString.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export type NotificationPermission = "default" | "granted" | "denied";

export interface UsePushSubscriptionResult {
  supported: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
  enable(): Promise<void>;
  error: string | null;
}

export function usePushSubscription(): UsePushSubscriptionResult {
  const [permission, setPermission] = useState<NotificationPermission>(
    PUSH_SUPPORTED
      ? (Notification.permission as NotificationPermission)
      : "default",
  );
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = useCallback(async () => {
    if (!PUSH_SUPPORTED) return;
    setError(null);

    try {
      // 1. Request permission on the user gesture.
      if (Notification.permission === "denied") {
        setPermission("denied");
        return;
      }
      if (Notification.permission !== "granted") {
        const result = await Notification.requestPermission();
        setPermission(result as NotificationPermission);
        if (result !== "granted") return;
      }

      // 2. Get the service worker registration.
      const registration = await navigator.serviceWorker.ready;

      // 3. Fetch the VAPID public key.
      const keyRes = await fetch("/api/notifications/vapid-public-key");
      if (!keyRes.ok) throw new Error("Failed to fetch VAPID key");
      const vapidPublicKey = await keyRes.text();

      // 4. Subscribe (or reuse existing subscription).
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(vapidPublicKey),
        });
      }

      // 5. POST the serialised subscription to the server.
      const subJson = subscription.toJSON();
      const postRes = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subJson),
      });
      if (!postRes.ok) throw new Error(`Subscribe failed: ${postRes.status}`);

      setSubscribed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { supported: PUSH_SUPPORTED, permission, subscribed, enable, error };
}
