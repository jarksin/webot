import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebotApplication } from "../src/application.js";
import { SettingsStore } from "../src/settings-store.js";

test("observes rejected inbound IDs and explicitly syncs contact names", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-app-dir-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.load();
  await settingsStore.save({
    channels: ["pad"],
    policy: { ownerSenderIds: ["owner_wxid"] },
    pad: {
      sources: [{
        id: "small",
        displayName: "小号",
        selfId: "wxid_small",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "secret",
        allowedChatIds: [],
        allowedSenderIds: [],
      }],
    },
  });
  const requests = [];
  const application = new WebotApplication({
    env: {
      WEBOT_DATA_DIR: directory,
      WEBOT_RUNTIME_MODE: "source",
      WEBOT_REPO_DIR: directory,
    },
    settingsStore,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            Code: 0,
            Data: {
              ContactList: [{
                UserName: "project@chatroom",
                NickName: "项目讨论群",
              }],
            },
          };
        },
      };
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();

  const received = await application.receive({
    transport: "pad",
    sourceId: "small",
    sourceName: "小号",
    messageId: "group-1",
    timestamp: Date.now(),
    chatType: "group",
    chatId: "project@chatroom",
    conversationId: "group:small:project@chatroom",
    senderId: "wxid_member",
    senderName: "",
    selfId: "wxid_small",
    direction: "incoming",
    text: "未触发消息",
    mentions: [],
  });
  assert.equal(received.reason, "chat-not-allowed");
  assert.deepEqual(
    application.directory({ sourceId: "small", entityType: "group" })
      .map((entry) => entry.entity_id),
    ["project@chatroom"],
  );

  const synced = await application.syncDirectory("small");
  assert.equal(synced.imported, 1);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].options.headers["X-Access-Token"],
    "secret",
  );
  assert.equal(
    application.directory({ sourceId: "small", query: "项目" })[0]
      .display_name,
    "项目讨论群",
  );
  application.caseStore.close();
});
