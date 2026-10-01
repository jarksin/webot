import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { acceptedMessage, WebotRuntime } from "../src/runtime.js";
import { requesterAccess } from "../src/security.js";
import { SessionStore } from "../src/session-store.js";
import { normalizePadEnvelope } from "../src/normalize.js";

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

test("keyword-only Pad sources require both the allowlist and an explicit summon", () => {
  const sourceConfig = loadConfig({}, {
    pad: { sources: [{
      id: "main",
      selfId: "wxid_bot",
      enabled: true,
      allowSelf: true,
      keywordOnly: true,
      ignoreAllowlist: false,
      allowedChatIds: ["allowed@chatroom"],
      allowedSenderIds: ["wxid_friend"],
      blockedSenderIds: ["wxid_blocked"],
      triggerKeywords: ["webot"],
      botNames: ["Webot", "helper"],
    }] },
  });
  const message = {
    transport: "pad",
    sourceId: "main",
    chatType: "private",
    chatId: "wxid_friend",
    senderId: "wxid_friend",
    selfId: "wxid_bot",
    direction: "incoming",
    text: "webot hello",
    mentions: [],
  };
  assert.equal(acceptedMessage(message, sourceConfig).text, "hello");
  for (const text of ["hello", "helper hello", "@Webot hello", "webotany hello"]) {
    assert.equal(acceptedMessage({ ...message, text }, sourceConfig).reason, "private-not-triggered");
  }
  for (const text of ["webot hello", "@Webot hello"]) {
    assert.equal(acceptedMessage({
      ...message, chatId: "wxid_stranger", senderId: "wxid_stranger", text,
    }, sourceConfig).reason, "sender-not-allowed");
  }
  const group = { ...message, chatType: "group", chatId: "allowed@chatroom" };
  assert.equal(acceptedMessage(group, sourceConfig).accepted, true);
  assert.equal(acceptedMessage({
    ...group, text: "hello", mentions: ["wxid_bot"],
  }, sourceConfig).reason, "group-not-triggered");
  assert.equal(acceptedMessage({
    ...group, chatId: "other@chatroom", mentions: ["wxid_bot"],
  }, sourceConfig).reason, "chat-not-allowed");
  assert.equal(acceptedMessage({
    ...message, senderId: "wxid_blocked",
  }, sourceConfig).reason, "sender-blocked");
  const self = {
    ...message, chatId: "wxid_bot", senderId: "wxid_bot",
    selfConversation: true, exactSelfChat: true, direction: "outgoing",
  };
  assert.equal(acceptedMessage(self, sourceConfig).accepted, true);
  assert.equal(acceptedMessage({
    ...self, text: "hello",
  }, sourceConfig).reason, "private-not-triggered");
  assert.equal(acceptedMessage({
    ...self, text: "【AI】webot hello",
  }, sourceConfig).reason, "assistant-echo");
  assert.equal(acceptedMessage({
    ...message, senderId: "wxid_bot", direction: "outgoing", chatId: "wxid_stranger",
  }, sourceConfig).reason, "sender-not-allowed");
  sourceConfig.pad.sources[0].enabled = false;
  assert.equal(acceptedMessage(message, sourceConfig).reason, "source-disabled");
});

test("strict private allowlists preserve one peer conversation without keyword bypass", () => {
  const sourceConfig = loadConfig({}, {
    pad: { sources: [{
      id: "small",
      selfId: "wxid_small",
      enabled: true,
      allowSelf: false,
      allowlistOnly: true,
      allowedSenderIds: ["wxid_owner"],
      selfChatPeers: ["wxid_owner"],
      acceptSelfChatPeerMessages: true,
      triggerKeywords: ["webot"],
      botNames: ["Webot"],
    }] },
  });
  const message = {
    transport: "pad", sourceId: "small", chatType: "private",
    chatId: "wxid_owner", senderId: "wxid_owner", selfId: "wxid_small",
    direction: "incoming", selfPeer: true, text: "hello", mentions: [],
  };
  assert.equal(acceptedMessage(message, sourceConfig).accepted, true);
  assert.equal(acceptedMessage({
    ...message, selfPeer: false, chatId: "wxid_stranger",
    senderId: "wxid_stranger", text: "webot hello",
  }, sourceConfig).reason, "sender-not-allowed");
  assert.equal(acceptedMessage({
    ...message, chatId: "room@chatroom", chatType: "group", text: "webot hello",
    selfPeer: false, mentions: ["wxid_small"],
  }, sourceConfig).reason, "chat-not-allowed");
  assert.equal(acceptedMessage({
    ...message, senderId: "wxid_small", direction: "outgoing",
  }, sourceConfig).reason, "self-peer-outgoing");
});

test("isolated peer ingress does not trigger the primary account or echo its own reply", () => {
  const sourceConfig = loadConfig({}, {
    pad: { sources: [
      {
        id: "main", selfId: "wxid_owner", allowSelf: true, keywordOnly: true,
        triggerKeywords: ["webot"], blockedChatIds: ["wxid_small"],
        blockedSenderIds: ["wxid_small"],
      },
      {
        id: "small", selfId: "wxid_small", allowlistOnly: true, allowSelf: false,
        selfChatPeers: ["wxid_owner"], acceptSelfChatPeerMessages: true,
        allowedSenderIds: ["wxid_owner"],
      },
    ] },
  });
  const normalize = (sourceId, from, to, text) => normalizePadEnvelope({
    Data: { messages: [{
      NewMsgId: "isolated-pair", MsgType: 1,
      FromUserName: from, ToUserName: to, Content: text,
    }] },
  }, sourceConfig.pad.sources.find((source) => source.id === sourceId))[0];
  assert.equal(acceptedMessage(
    normalize("small", "wxid_owner", "wxid_small", "hello"),
    sourceConfig,
  ).accepted, true);
  assert.equal(acceptedMessage(
    normalize("small", "wxid_small", "wxid_owner", "reply"),
    sourceConfig,
  ).reason, "self-peer-outgoing");
  assert.equal(acceptedMessage(
    normalize("main", "wxid_small", "wxid_owner", "webot reply"),
    sourceConfig,
  ).reason, "chat-blocked");
  assert.equal(acceptedMessage(
    normalize("main", "wxid_owner", "wxid_small", "webot hello"),
    sourceConfig,
  ).reason, "chat-blocked");
  assert.equal(acceptedMessage(
    normalize("small", "wxid_stranger", "wxid_small", "webot hello"),
    sourceConfig,
  ).reason, "sender-not-allowed");
});

test("drops empty assistant envelopes before they can trigger a case", () => {
  const message = {
    transport: "hook",
    messageId: "empty-envelope",
    chatType: "group",
    chatId: "room",
    senderId: "peer",
    selfId: "wxid_bot",
    text: '{"reply_text":"","attachments":[]}',
    mentions: ["wxid_bot"],
  };
  assert.deepEqual(acceptedMessage(message, config()), {
    accepted: false,
    reason: "empty-assistant-payload",
  });
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
  assert.equal(
    acceptedMessage({
      ...base,
      selfConversation: false,
      selfPeer: false,
      senderId: "wxid_small",
      chatId: "filehelper",
      direction: "outgoing",
    }, sourceConfig).reason,
    "pad-outgoing",
  );
  assert.equal(
    acceptedMessage({
      ...base,
      chatType: "group",
      chatId: "project@chatroom",
      senderId: "wxid_small",
      selfConversation: false,
      selfPeer: false,
      text: "webot status",
      direction: "outgoing",
    }, sourceConfig).reason,
    "pad-outgoing",
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
  const exactSelf = {
    ...base,
    chatId: "wxid_small",
    senderId: "wxid_small",
    selfConversation: true,
    selfPeer: false,
    exactSelfChat: true,
    direction: "outgoing",
  };
  sourceConfig.pad.sources[0].allowSelf = true;
  assert.equal(acceptedMessage(exactSelf, sourceConfig).accepted, true);
  assert.equal(
    acceptedMessage({ ...exactSelf, text: "【AI】机器人回复" }, sourceConfig)
      .reason,
    "assistant-echo",
  );
  sourceConfig.pad.sources[0].allowSelf = false;
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

test("allowlist bypass accepts all private chats and triggered groups", () => {
  const sourceConfig = config();
  sourceConfig.pad.sources = [{
    id: "small",
    selfId: "wxid_small",
    allowSelf: false,
    selfChatPeers: new Set(),
    acceptSelfChatPeerMessages: false,
    ignoreAllowlist: true,
    allowedChatIds: new Set(),
    blockedChatIds: new Set(["blocked@chatroom"]),
    allowedSenderIds: new Set(),
    blockedSenderIds: new Set(["wxid_blocked"]),
    privateNicknameAllowlist: new Set(),
    triggerKeywords: new Set(["小水瓜"]),
    botNames: new Set(["小水瓜"]),
    strictPolicy: true,
  }];
  const privateMessage = {
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
  const groupMessage = {
    ...privateMessage,
    chatType: "group",
    chatId: "new@chatroom",
    senderId: "wxid_member",
    text: "小水瓜 ping",
  };

  assert.equal(acceptedMessage(privateMessage, sourceConfig).accepted, true);
  assert.equal(acceptedMessage(groupMessage, sourceConfig).text, "ping");
  assert.equal(
    acceptedMessage(
      { ...privateMessage, senderId: "WXID_BLOCKED" },
      sourceConfig,
    ).reason,
    "sender-blocked",
  );
  assert.equal(
    acceptedMessage(
      { ...groupMessage, chatId: "BLOCKED@CHATROOM" },
      sourceConfig,
    ).reason,
    "chat-blocked",
  );
  assert.deepEqual(
    acceptedMessage(
      { ...groupMessage, text: "群聊上下文" },
      sourceConfig,
    ),
    {
      accepted: false,
      reason: "group-not-triggered",
      retainGroupContext: true,
    },
  );

  sourceConfig.policy.blockedSenderIds.add("wxid_stranger");
  assert.equal(
    acceptedMessage(privateMessage, sourceConfig).reason,
    "blocked",
  );
  assert.equal(
    acceptedMessage(
      {
        ...privateMessage,
        chatId: "gh_240fbf8b33e4",
        senderId: "gh_240fbf8b33e4",
      },
      sourceConfig,
    ).reason,
    "official-account",
  );
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
  assert.equal(
    acceptedMessage(
      {
        ...base,
        senderId: "wxid_small",
        direction: "outgoing",
        text: "@小水瓜 介绍一下自己",
      },
      sourceConfig,
    ).text,
    "介绍一下自己",
  );
  assert.equal(
    acceptedMessage(
      {
        ...base,
        senderId: "wxid_small",
        direction: "outgoing",
        text: "介绍一下自己",
      },
      sourceConfig,
    ).reason,
    "pad-outgoing",
  );
  assert.equal(
    acceptedMessage(
      {
        ...base,
        chatType: "group",
        chatId: "test@chatroom",
        senderId: "wxid_small",
        direction: "outgoing",
        text: "@小水瓜 介绍一下自己",
      },
      sourceConfig,
    ).reason,
    "pad-outgoing",
  );
  assert.equal(
    acceptedMessage(
      {
        ...base,
        senderId: "wxid_small",
        direction: "outgoing",
        text: "[引用回复] @小水瓜 看下引用内容\n引用：上一条回复",
        app: {
          title: "@小水瓜 看下引用内容",
          reference: { content: "上一条回复" },
        },
      },
      sourceConfig,
    ).text,
    "[引用回复] 看下引用内容\n引用：上一条回复",
  );
  assert.equal(
    acceptedMessage(
      {
        ...base,
        senderId: "wxid_small",
        direction: "outgoing",
        text: "[引用回复] 普通回复\n引用：@小水瓜 旧消息",
        app: {
          title: "普通回复",
          reference: { content: "@小水瓜 旧消息" },
        },
      },
      sourceConfig,
    ).reason,
    "pad-outgoing",
  );
  assert.equal(
    acceptedMessage(
      {
        ...base,
        senderId: "wxid_small",
        direction: "outgoing",
        text: "小助手 检查状态",
      },
      sourceConfig,
    ).text,
    "检查状态",
  );
});
