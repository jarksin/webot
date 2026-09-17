#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { WebotApplication } from "../src/application.js";
import { createLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";
import { SettingsStore } from "../src/settings-store.js";
import { WEBOT_VERSION } from "../src/version.js";

async function main() {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${process.env.WEBOT_VERSION || WEBOT_VERSION}\n`);
    return;
  }

  const dataDir = path.resolve(
    process.env.WEBOT_DATA_DIR ||
      path.join(os.homedir(), "Library", "Application Support", "Webot"),
  );
  const settingsStore = new SettingsStore(
    process.env.WEBOT_SETTINGS_FILE || path.join(dataDir, "settings.json"),
  );
  const logger = createLogger(process.env.WEBOT_LOG_LEVEL || "info");
  const application = new WebotApplication({
    settingsStore,
    logger,
  });
  await application.initialize();
  const app = createServer({ application, logger });

  const address = await app.start();
  logger.info("webot started", {
    address: `${address.address}:${address.port}`,
    channels: [...application.config.channels],
    outboundMode: application.config.outboundMode,
    assistant: application.config.assistant.mode,
    padSources: application.config.pad.sources.map((source) => ({
      id: source.id,
      selfId: source.selfId,
      wsConfigured: Boolean(source.wsUrl),
      credentialReady: Boolean(source.accessToken),
      credentialSource: source.credentialSource,
    })),
    telegramSources: application.config.telegram.sources.map((source) => ({
      id: source.id,
      sessionConfigured: Boolean(source.sessionPath),
      credentialReady: Boolean(source.apiId && source.apiHash),
      credentialSource: source.credentialSource,
    })),
  });

  async function shutdown(signal) {
    logger.info("webot stopping", { signal });
    await app.stop();
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  process.stderr.write(`webot failed: ${error.message}\n`);
  process.exitCode = 1;
});
