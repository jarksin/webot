import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebotApplication } from "../src/application.js";
import { SettingsStore } from "../src/settings-store.js";

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-replay-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.save({
    channels: ["pad"],
    policy: { ownerSenderIds: ["owner"] },
    assistant: { mode: "echo" },
    caseManagement: { autoRun: false, autoSend: false },
    pad: {
      sources: [{
        id: "small",
        selfId: "bot",
        allowedChatIds: [],
        botNames: ["Webot"],
      }],
    },
  });
  const application = new WebotApplication({
    settingsStore,
    env: { WEBOT_DATA_DIR: directory },
    fetchImpl: async () => { throw new Error("unexpected network request"); },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();
  t.after(async () => {
    await application.stopConnectors();
    application.caseStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const message = {
    transport: "pad",
    sourceId: "small",
    sourceName: "Small",
    selfId: "bot",
    senderId: "owner",
    senderName: "Owner",
    messageType: 49,
    messageId: "6415032614165678096",
    timestamp: Date.now() - 60_000,
    chatType: "group",
    chatId: "room@chatroom",
    conversationId: "group:small:room@chatroom",
    direction: "incoming",
    text: "@Webot question",
    mentions: ["bot"],
    reference: { messageId: "quoted-1", text: "original question" },
    attachments: [{
      kind: "image",
      filename: "image.jpg",
      downloadContext: { endpoint: "/api/v1/media/download-img-binary", msgId: 123 },
    }],
    ...overrides,
  };
  assert.equal((await application.receive(message)).accepted, false);
  const source = application.config.pad.sources[0];
  return { application, message, source };
}

test("replay uses the current policy and preserves the original captured envelope", async (t) => {
  const { application, message, source } = await fixture(t);
  const stillRejected = await application.replayCapturedMessage("small", message.messageId);
  assert.equal(stillRejected.reason, "chat-not-allowed");
  source.allowedChatIds.add(message.chatId);
  const result = await application.replayCapturedMessage("small", message.messageId);
  assert.equal(result.accepted, true);
  assert.equal(result.queued, false);
  const stored = application.caseStore.messages(result.caseId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].message.messageId, message.messageId);
  assert.equal(stored[0].message.timestamp, message.timestamp);
  assert.equal(stored[0].message.senderId, message.senderId);
  assert.deepEqual(stored[0].message.mentions, message.mentions);
  assert.deepEqual(stored[0].message.reference, message.reference);
  assert.deepEqual(stored[0].message.attachments, message.attachments);
  assert.equal(stored[0].message.text, "question");
  const captured = application.caseStore.syncedMessageByMessageId("small", message.messageId);
  assert.equal(captured.accepted, true);
  assert.equal(captured.decision, "accepted");
  assert.equal(application.capturedMessages({}).total, 1);
  const history = await application.caseManager.sessionStore.history(result.caseId);
  assert.deepEqual(history.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "question" },
  ]);
});

test("accepted and concurrent replays cannot create duplicate messages or runs", async (t) => {
  const { application, message, source } = await fixture(t);
  source.allowedChatIds.add(message.chatId);
  application.config.caseManagement.autoRun = true;
  application.caseStore.setRuntimeSetting("workers_paused", "1");
  const results = await Promise.all([
    application.replayCapturedMessage("small", message.messageId),
    application.replayCapturedMessage("small", message.messageId),
  ]);
  const accepted = results.find((result) => result.accepted);
  assert(accepted);
  assert.equal(accepted.queued, true);
  assert.equal(results.filter((result) => result.reason === "duplicate").length, 1);
  assert.equal(application.caseManager.queue.length, 1);
  assert.equal(application.caseStore.messages(accepted.caseId).length, 1);
  assert.equal((await application.caseManager.sessionStore.history(accepted.caseId)).length, 1);
  const repeat = await application.replayCapturedMessage("small", message.messageId);
  assert.equal(repeat.reason, "duplicate");
  assert.equal(application.caseManager.queue.length, 1);
  assert.equal(application.caseStore.syncedMessageByMessageId("small", message.messageId).accepted, true);
});

test("replay does not bypass current blacklists, account state, or group triggers", async (t) => {
  for (const [name, change, expected, overrides] of [
    ["blocked group", ({ source, message }) => source.blockedChatIds.add(message.chatId), "chat-blocked"],
    ["blocked sender", ({ source, message }) => source.blockedSenderIds.add(message.senderId), "sender-blocked"],
    ["disabled source", ({ source }) => { source.enabled = false; }, "source-disabled"],
    ["removed source", ({ application }) => { application.config.pad.sources = []; }, "source-not-configured"],
    ["disabled channel", ({ application }) => application.config.channels.delete("pad"), "channel-disabled"],
    ["changed account", ({ source }) => { source.selfId = "another-bot"; }, "source-account-changed"],
    ["missing trigger", () => {}, "group-not-triggered", { text: "question", mentions: [] }],
    ["unsupported message", () => {}, "unsupported-message-type", { messageType: 999 }],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, overrides);
      f.source.allowedChatIds.add(f.message.chatId);
      change(f);
      const result = await f.application.replayCapturedMessage("small", f.message.messageId);
      assert.equal(result.accepted, false);
      assert.equal(result.reason, expected);
      assert.equal(f.application.listCases({}).total, 0);
      assert.equal(f.application.caseStore.syncedMessageByMessageId("small", f.message.messageId).decision, expected);
    });
  }
});

test("replay requires an exact stored source and string message ID", async (t) => {
  const { application, message } = await fixture(t);
  for (const [sourceId, messageId] of [
    ["other", message.messageId],
    ["small", "expired"],
    ["small", 6415032614165678096],
    ["", message.messageId],
    ["small", ""],
  ]) {
    await assert.rejects(application.replayCapturedMessage(sourceId, messageId));
  }
  assert.equal(application.listCases({}).total, 0);
});
