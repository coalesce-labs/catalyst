/**
 * Smee-client lifecycle wrapper.
 *
 * Wraps the smee.io tunnel client so the rest of the codebase doesn't depend
 * directly on the package — and so tests can substitute a fake constructor.
 *
 * The real client is created lazily on first `start()` (instead of at module
 * load) so that the package's network setup doesn't run during tests that
 * don't actually use the tunnel.
 */

export interface WebhookTunnel {
  start(): Promise<void>;
  stop(): Promise<void>;
  isStarted(): boolean;
}

export interface TunnelLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface SmeeClientLike {
  start(): Promise<unknown>;
  stop(): Promise<void> | void;
}

export interface SmeeClientOptions {
  source: string;
  target: string;
  logger?: { info: (msg: string) => void; error: (msg: string) => void };
}

export type SmeeClientFactory = (opts: SmeeClientOptions) => SmeeClientLike;

export interface CreateWebhookTunnelOpts {
  /** smee.io channel URL (e.g. https://smee.io/abc123). */
  source: string;
  /** Local target URL (e.g. http://localhost:7400/api/webhook). */
  target: string;
  logger?: TunnelLogger;
  /** Override the SmeeClient constructor (for tests). */
  factory?: SmeeClientFactory;
}

const noopLogger: TunnelLogger = {};

async function defaultFactory(
  opts: SmeeClientOptions,
): Promise<SmeeClientLike> {
  const mod = (await import("smee-client")) as {
    default: new (o: SmeeClientOptions) => SmeeClientLike;
  };
  const Ctor = mod.default;
  return new Ctor(opts);
}

export function createWebhookTunnel(
  opts: CreateWebhookTunnelOpts,
): WebhookTunnel {
  const logger = opts.logger ?? noopLogger;
  let client: SmeeClientLike | null = null;
  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    const smeeLogger = {
      info: (m: string) => logger.info?.(`[webhook-tunnel] ${m}`),
      error: (m: string) => logger.error?.(`[webhook-tunnel] ${m}`),
    };
    try {
      if (opts.factory) {
        client = opts.factory({
          source: opts.source,
          target: opts.target,
          logger: smeeLogger,
        });
      } else {
        client = await defaultFactory({
          source: opts.source,
          target: opts.target,
          logger: smeeLogger,
        });
      }
      await client.start();
      started = true;
      logger.info?.(
        `[webhook-tunnel] connected ${opts.source} → ${opts.target}`,
      );
    } catch (err) {
      logger.error?.(
        `[webhook-tunnel] failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      client = null;
      throw err;
    }
  }

  async function stop(): Promise<void> {
    if (!started || client === null) return;
    try {
      await client.stop();
    } catch (err) {
      logger.error?.(
        `[webhook-tunnel] stop failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      started = false;
      client = null;
    }
  }

  return {
    start,
    stop,
    isStarted: () => started,
  };
}
