import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { acceptedMessage, WebotRuntime } from "../src/runtime.js";
import { requesterAccess } from "../src/security.js";
import { SessionStore } from "../src/session-store.js";

function config(overrides = {}) {
  return loadConfig({
    WEBOT_SELF_WXID: "wxid_bot",
    WEBOT_BOT_NAMES: "Webot",
    WEBOT_GROUP_TRIGGERS: "webot",
    ...overrides,
  });
}

test("grants owner access only by stable sender id", () => {
  const owners = new Set(["owner_wxid", "wxid_small"]);
  assert.equal(
    requesterAccess({ senderId: "owner_wxid", senderName: "Owner" }, owners),
    "owner",
  );
  assert.equal(
    requesterAccess({ senderId: "wxid_other", senderName: "Owner" }, owners),
    "public",
  );
  assert.equal(
    requesterAccess({ senderId: "WXID_SMALL", senderName: "其他昵称" }, owners),
    "owner",
  );
});

test("requires a trigger in group chats", () => {
  const base = {
    transport: "hook",
    messageId: "1",
    chatType: "group",
    chatId: "room",
    senderId: "peer",
    selfId: "wxid_bot",
    text: "hello",
    mentions: [],
  };
  assert.deepEqual(acceptedMessage(base, config()), {
    accepted: false,
    reason: "group-not-triggered",
    retainGroupContext: true,
  });
  assert.equal(
    acceptedMessage({ ...base, text: "webot hello" }, config()).text,
    "hello",
  );
  assert.equal(
    acceptedMessage({ ...base, mentions: ["wxid_bot"] }, config()).accepted,
    true,
  );
});

test("serializes, persists, deduplicates, and dry-runs replies", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-test-"));
  const sent = [];
  const runtime = new WebotRuntime({
    config: config(),
    provider: {
      async reply({ message }) {
        return `reply:${message.text}`;
      },
    },
    store: new SessionStore(directory, 4),
    transports: {
      hook: {
        async send(message, text) {
          sent.push({ message, text });
          return { ok: true, dryRun: true };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const message = {
    transport: "hook",
    messageId: "42",
    timestamp: Date.now(),
    chatType: "private",
    chatId: "peer",
    senderId: "peer",
    selfId: "wxid_bot",
    text: "hello",
    mentions: [],
  };

  const first = await runtime.receive(message);
  const second = await runtime.receive(message);
  assert.equal(first.accepted, true);
  assert.equal(second.reason, "duplicate");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "reply:hello");

  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const stored = JSON.parse(
    await fs.readFile(path.join(directory, files[0]), "utf8"),
  );
  assert.deepEqual(
    stored.history.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply:hello" },
    ],
  );
});

test("applies source-scoped self, group, and nickname policies", () => {
  const sourceConfig = config();
  sourceConfig.pad.sources = [{
    id: "small",
    selfId: "wxid_small",
    allowSelf: false,
    selfChatPeers: new Set(["owner_wxid"]),
    acceptSelfChatPeerMessages: true,
    allowedChatIds: new Set(["family@chatroom"]),
    allowedSenderIds: new Set(),
    privateNicknameAllowlist: new Set(["家人"]),
    strictPolicy: true,
  }];
  const base = {
    transport: "pad",
    sourceId: "small",
    messageId: "1",
    chatType: "private",
    chatId: "owner_wxid",
    senderId: "owner_wxid",
    senderName: "Owner",
    selfId: "wxid_small",
    text: "继续",
    mentions: [],
    selfConversation: true,
    selfPeer: true,
    direction: "incoming",
  };

  assert.equal(acceptedMessage(base, sourceConfig).accepted, true);
  assert.equal(
    acceptedMessage({ ...base, direction: "outgoing" }, sourceConfig).reason,
    "self-peer-outgoing",
  );
  sourceConfig.pad.sources[0].acceptSelfChatPeerMessages = false;
  assert.equal(
    acceptedMessage(base, sourceConfig).reason,
    "self-peer-incoming-disabled",
  );
  sourceConfig.pad.sources[0].acceptSelfChatPeerMessages = true;
  assert.equal(
    acceptedMessage({ ...base, text: "【AI】收到" }, sourceConfig).reason,
    "assistant-echo",
  );
  assert.equal(
    acceptedMessage(
      { ...base, text: "【AI 1/2】分段回声" },
      sourceConfig,
    ).reason,
    "assistant-echo",
  );
  assert.equal(acceptedMessage({
    ...base,
    selfConversation: false,
    selfPeer: false,
    senderId: "wxid_relative",
    senderName: "家人",
    chatId: "wxid_relative",
  }, sourceConfig).accepted, true);
  assert.equal(acceptedMessage({
    ...base,
    chatType: "group",
    chatId: "other@chatroom",
    senderId: "wxid_member",
    selfConversation: false,
    selfPeer: false,
    text: "webot ping",
  }, sourceConfig).reason, "chat-not-allowed");
});

test("uses account-scoped bot names and trigger keywords", () => {
  const sourceConfig = config();
  sourceConfig.pad.sources = [{
    id: "small",
    selfId: "wxid_small",
    allowSelf: false,
    selfChatPeers: new Set(),
    acceptSelfChatPeerMessages: false,
    allowedChatIds: new Set(["family@chatroom"]),
    allowedSenderIds: new Set(),
    privateNicknameAllowlist: new Set(),
    triggerKeywords: new Set(["小助手"]),
    botNames: new Set(["阿水"]),
    strictPolicy: true,
  }];
  const base = {
    transport: "pad",
    sourceId: "small",
    messageId: "1",
    chatType: "group",
    chatId: "family@chatroom",
    senderId: "wxid_member",
    selfId: "wxid_small",
    text: "webot ping",
    mentions: [],
  };

  assert.equal(
    acceptedMessage(base, sourceConfig).reason,
    "group-not-triggered",
  );
  assert.equal(
    acceptedMessage({ ...base, text: "小助手 ping" }, sourceConfig).text,
    "ping",
  );
  assert.equal(
    acceptedMessage({ ...base, text: "@阿水 ping" }, sourceConfig).accepted,
    true,
  );
});

test("allows private bot-name prefixes without opening all private messages", () => {
  const sourceConfig = config();
  sourceConfig.pad.sources = [{
    id: "small",
    selfId: "wxid_small",
    allowSelf: false,
    selfChatPeers: new Set(),
    acceptSelfChatPeerMessages: false,
    allowedChatIds: new Set(),
    allowedSenderIds: new Set(),
    privateNicknameAllowlist: new Set(),
    triggerKeywords: new Set(["小助手"]),
    botNames: new Set(["小水瓜"]),
    strictPolicy: true,
  }];
  const base = {
    transport: "pad",
    sourceId: "small",
    messageId: "1",
    chatType: "private",
    chatId: "wxid_stranger",
    senderId: "wxid_stranger",
    senderName: "陌生人",
    selfId: "wxid_small",
    text: "你好",
    mentions: [],
    selfConversation: false,
    selfPeer: false,
    direction: "incoming",
  };

  assert.equal(
    acceptedMessage(base, sourceConfig).reason,
    "sender-not-allowed",
  );
  assert.equal(
    acceptedMessage(
      { ...base, text: "@小水瓜 帮我查一下" },
      sourceConfig,
    ).text,
    "帮我查一下",
  );
  assert.equal(
    acceptedMessage(
      { ...base, text: "请 @小水瓜 帮我查一下" },
      sourceConfig,
    ).reason,
    "sender-not-allowed",
  );
});
