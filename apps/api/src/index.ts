import { getEnv } from "@adstrackio/config";
import { buildApp } from "./app.js";
import { processPendingWebhookDeliveries } from "./modules/webhooks/webhook-delivery-worker.js";

/** How often the webhook delivery worker polls for fanned-out events and
 * due deliveries (Phase 11). Deliberately just a plain interval on this
 * process — see modules/webhooks/webhook-delivery-worker.ts's doc
 * comment for why this stays a minimal Postgres-backed queue rather than
 * a separate worker process or Redis/BullMQ. Only ever started here, in
 * the real process entrypoint — apps/api/src/app.ts's `buildApp` (what
 * every test imports) never starts it, so tests stay fully deterministic
 * and this never keeps a test process alive. */
const WEBHOOK_DELIVERY_POLL_INTERVAL_MS = 5_000;

async function main() {
  const env = getEnv();
  const app = await buildApp({ env });

  try {
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error, "failed to start api server");
    process.exit(1);
  }

  const deliveryInterval = setInterval(() => {
    processPendingWebhookDeliveries(app.prisma, env).catch((error) => {
      app.log.error(error, "webhook delivery worker iteration failed");
    });
  }, WEBHOOK_DELIVERY_POLL_INTERVAL_MS);
  deliveryInterval.unref();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(deliveryInterval);
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
