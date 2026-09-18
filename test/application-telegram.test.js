import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebotApplication } from "../src/application.js";
import { SettingsStore } from "../src/settings-store.js";

function telegramGroupMessage(overrides = {}) {
  return {
    transport: "telegram",
    sourceId: "tg-main",
    sourceName: "Telegram",
    messageType: 1,
    messageId: "telegram:-1001:1",
    timestamp: Date.now(),
    chatType: "group",
    chatId: "tg:-1001",
    chatName: "Unlisted group",
    conversationId: "group:tg:-1001",
    senderId: "tg:42",
    senderName: "Member",
    selfId: "tg:7",
    direction: "incoming",
    text: "background traffic",
    mentions: [],
    attachments: [],
    ...overrides,
  };
}

test("drops non-allowlisted Telegram groups before persistence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-app-tg-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.load();
  await settingsStore.save({
    channels: ["telegram"],
    telegram: {
      sources: [{
        id: "tg-main",
        displayName: "Telegram",
        apiId: "123",
        apiHash: "hash",
        sessionPath: path.join(directory, "telegram.session"),
        allowedChatIds: ["tg:-1002"],
      }],
    },
  });
  const application = new WebotApplication({
    env: {
      WEBOT_DATA_DIR: directory,
      WEBOT_RUNTIME_MODE: "source",
      WEBOT_REPO_DIR: process.cwd(),
    },
    settingsStore,
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();

  const rejected = await application.receive(telegramGroupMessage());
  assert.deepEqual(rejected, {
    accepted: false,
    reason: "chat-not-allowed",
  });
  assert.equal(
    application.caseStore.db.prepare(`
      SELECT COUNT(*) AS count FROM synced_messages
      WHERE source_id='tg-main'
    `).get().count,
    0,
  );
  assert.equal(
    application.directory({ sourceId: "tg-main" }).length,
    0,
  );

  const allowed = await application.receive(telegramGroupMessage({
    messageId: "telegram:-1002:1",
    chatId: "TG:-1002",
    chatName: "Allowed group",
    conversationId: "group:tg:-1002",
  }));
  assert.equal(allowed.accepted, false);
  assert.equal(allowed.reason, "group-not-triggered");
  assert.equal(allowed.contextStored, true);
  assert.equal(
    application.caseStore.db.prepare(`
      SELECT COUNT(*) AS count FROM synced_messages
      WHERE source_id='tg-main' AND chat_type='group'
    `).get().count,
    1,
  );
  assert.equal(
    application.caseStore.db.prepare(`
      SELECT COUNT(*) AS count FROM group_context_messages
      WHERE source_id='tg-main'
    `).get().count,
    1,
  );

  application.caseStore.close();
});
