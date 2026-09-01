import { getEnv } from "@adstrackio/config";
import { buildTrackerApp } from "./app.js";

async function main() {
  const env = getEnv();
  const app = await buildTrackerApp({ env });

  try {
    await app.listen({ port: env.TRACKER_PORT, host: "0.0.0.0" });
  } catch (error) {
    app.log.error(error, "failed to start tracker server");
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
