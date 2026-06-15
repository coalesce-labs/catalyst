import webpush from "web-push";
import type { PushSubscriptionRecord } from "./push-subscriptions";
import type { PushNotification, ProjectorBoard } from "./notification-filter";

interface PushStore {
  listSubscriptions(): PushSubscriptionRecord[];
  deleteSubscription(endpoint: string): void;
}

interface Projector {
  project(board: ProjectorBoard): PushNotification[];
}

type SendFn = (
  sub: PushSubscriptionRecord,
  notification: PushNotification,
) => Promise<void>;

interface PushBridgeOptions {
  store: PushStore;
  projector: Projector;
  send?: SendFn;
}

const defaultSend: SendFn = async (sub, notification) => {
  await webpush.sendNotification(
    {
      endpoint: sub.endpoint,
      keys: sub.keys,
    },
    JSON.stringify(notification),
  );
};

export function createPushBridge({ store, projector, send = defaultSend }: PushBridgeOptions) {
  return {
    async onBoard(board: ProjectorBoard): Promise<void> {
      const notifications = projector.project(board);
      if (notifications.length === 0) return;
      const subs = store.listSubscriptions();
      for (const n of notifications) {
        for (const sub of subs) {
          try {
            await send(sub, n);
          } catch (err) {
            if ((err as { statusCode?: number }).statusCode === 410) {
              store.deleteSubscription(sub.endpoint);
            } else {
              console.error("[push-bridge] send failed (retained):", err);
            }
          }
        }
      }
    },
  };
}
