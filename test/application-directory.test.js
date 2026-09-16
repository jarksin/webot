import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebotApplication } from "../src/application.js";
import { SettingsStore } from "../src/settings-store.js";

test("persists rejected Pad sync messages and explicitly syncs contact names", async () => {
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
      const requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        async json() {
          if (url.endsWith("/v1/contacts/list")) {
            return {
              Code: 0,
              Data: {
                ContactUsernameList: [
                  "wxid_friend",
                  "project@chatroom",
                  "gh_service",
                  "newsapp",
                ],
                CountinueFlag: 0,
              },
            };
          }
          assert.equal(url.endsWith("/v1/contacts/detail"), true);
          assert.equal(
            requestBody.userName,
            "wxid_friend,project@chatroom,wxid_member",
          );
          return {
            Code: 0,
            Data: {
              ContactList: [
                {
                  UserName: "wxid_friend",
                  Remark: "同事",
                  NickName: "好友昵称",
                },
                {
                  UserName: "project@chatroom",
                  NickName: "项目讨论群",
                },
                {
                  UserName: "gh_service",
                  NickName: "服务号",
                  VerifyFlag: 8,
                },
              ],
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
    attachments: [{
      kind: "image",
      filename: "preview.jpg",
      size: 1024,
      data_base64: "must-not-be-persisted",
      localPath: "/tmp/preview.jpg",
    }],
  });
  assert.equal(received.reason, "chat-not-allowed");
  const syncedMessages = application.caseStore.syncedMessages({
    sourceId: "small",
    conversationId: "group:small:project@chatroom",
  });
  assert.equal(syncedMessages.length, 1);
  assert.equal(syncedMessages[0].text, "未触发消息");
  assert.equal(syncedMessages[0].decision, "chat-not-allowed");
  assert.equal(syncedMessages[0].accepted, false);
  assert.deepEqual(syncedMessages[0].attachments, [{
    kind: "image",
    filename: "preview.jpg",
    size: 1024,
  }]);
  assert.doesNotMatch(syncedMessages[0].metadata_json, /must-not-be-persisted/);
  assert.doesNotMatch(
    syncedMessages[0].attachments_json,
    /must-not-be-persisted|localPath|\/tmp\/preview\.jpg/,
  );

  const duplicate = await application.receive({
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
  assert.equal(duplicate.reason, "chat-not-allowed");
  assert.equal(
    application.caseStore.syncedMessages({
      sourceId: "small",
      conversationId: "group:small:project@chatroom",
    }).length,
    1,
  );
  const plan = application.caseStore.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM synced_messages
    WHERE source_id=? AND conversation_id=?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all("small", "group:small:project@chatroom", 50);
  assert.match(
    plan.map((item) => item.detail).join("\n"),
    /synced_messages_conversation_time/,
  );
  assert.deepEqual(
    application.directory({ sourceId: "small", entityType: "group" })
      .map((entry) => entry.entity_id),
    ["project@chatroom"],
  );
  application.caseStore.upsertIdentity({
    sourceId: "small",
    entityType: "user",
    entityId: "gh_service",
    displayName: "",
    origin: "message",
  });

  const synced = await application.syncDirectory("small");
  assert.equal(synced.imported, 2);
  assert.equal(synced.sources[0].discovered, 4);
  assert.equal(synced.sources[0].requested, 3);
  assert.equal(synced.sources[0].resolved, 2);
  assert.equal(synced.sources[0].named, 2);
  assert.equal(synced.sources[0].removed, 1);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].options.headers["X-Access-Token"],
    "secret",
  );
  assert.equal(
    application.directory({ sourceId: "small", query: "同事" })[0]
      .entity_id,
    "wxid_friend",
  );
  assert.equal(
    application.directory({ sourceId: "small", query: "项目" })[0]
      .display_name,
    "项目讨论群",
  );
  assert.equal(
    application.directory({ sourceId: "small", query: "gh_service" }).length,
    0,
  );
  application.caseStore.close();
});
