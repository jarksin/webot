import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";
import { normalizeTelegramBridgeEvent } from "../src/normalize.js";
import { acceptedMessage } from "../src/runtime.js";
import { requesterAccess } from "../src/security.js";
import {
  TelegramBridgeClient,
  TelegramTransport,
} from "../src/transports/telegram.js";

function source(overrides = {}) {
  return {
    id: "tg-main",
    displayName: "Telegram",
    enabled: true,
    pythonBin: "python3",
    bridgeScript: "/tmp/telegram_bridge.py",
    sessionPath: "/tmp/telegram.session",
    apiId: "123",
    apiHash: "hash",
    credentialSource: "inline",
    allowSelf: true,
    trustSelfAsOwner: true,
    listenSelf: true,
    ignoreAllowlist: false,
    allowedChatIds: new Set(),
    blockedChatIds: new Set(),
    allowedSenderIds: new Set(),
    blockedSenderIds: new Set(),
    privateNicknameAllowlist: new Set(),
    triggerKeywords: new Set(["webot"]),
    botNames: new Set(["Webot"]),
    strictPolicy: true,
    ...overrides,
  };
}

test("normalizes Telegram bridge messages into isolated transport events", () => {
  const message = normalizeTelegramBridgeEvent({
    type: "message",
    message_id: "42:9",
    telegram_message_id: 9,
    timestamp: 1_790_000_000_000,
    direction: "outgoing",
    chat_type: "private",
    chat_id: "tg:42",
    chat_name: "Saved Messages",
    sender_id: "tg:42",
    sender_name: "Owner",
    self_id: "tg:42",
    text: "status",
    mentions: [],
    self_conversation: true,
    exact_self_chat: true,
    reply_target: "tg:42",
  }, source());

  assert.equal(message.transport, "telegram");
  assert.equal(message.sourceId, "tg-main");
  assert.equal(message.messageId, "telegram:42:9");
  assert.equal(message.telegramMessageId, 9);
  assert.equal(message.conversationId, "private:tg:42");
  assert.equal(message.exactSelfChat, true);
});

test("normalizes Telegram image-only messages with a deferred download locator", () => {
  const message = normalizeTelegramBridgeEvent({
    type: "message",
    message_id: "42:10",
    telegram_message_id: 10,
    chat_type: "private",
    chat_id: "tg:42",
    sender_id: "tg:42",
    self_id: "tg:42",
    text: "",
    attachments: [{
      kind: "image",
      filename: "photo.jpg",
      size: 1234,
      mime: "image/jpeg",
      download_context: {
        type: "telegram",
        chat_id: "tg:42",
        message_id: 10,
      },
    }],
  }, source());

  assert.equal(message.text, "[图片]");
  assert.deepEqual(message.attachments, [{
    kind: "image",
    filename: "photo.jpg",
    size: 1234,
    mime: "image/jpeg",
    downloadContext: {
      type: "telegram",
      chatId: "tg:42",
      messageId: 10,
    },
  }]);
});

test("preserves Telegram reply content and image locator", () => {
  const message = normalizeTelegramBridgeEvent({
    type: "message",
    message_id: "42:11",
    chat_type: "private",
    chat_id: "tg:42",
    sender_id: "tg:42",
    self_id: "tg:42",
    text: "看一下",
    reference: {
      message_id: 10,
      telegram_message_id: 10,
      sender_id: "tg:7",
      sender_name: "Alice",
      text: "[图片]",
      attachments: [{
        kind: "image",
        filename: "photo.jpg",
        mime: "image/jpeg",
        download_context: {
          type: "telegram",
          chat_id: "tg:42",
          message_id: 10,
        },
      }],
    },
  }, source());

  assert.equal(message.reference.senderName, "Alice");
  assert.equal(message.reference.text, "[图片]");
  assert.equal(message.reference.attachments[0].downloadContext.messageId, 10);
});

test("Telegram strict policy accepts trusted self chat and rejects strangers", () => {
  const config = loadConfig({}, {
    telegram: {
      sources: [{
        id: "tg-main",
        apiId: "123",
        apiHash: "hash",
        sessionPath: "/tmp/telegram.session",
        allowSelf: true,
        trustSelfAsOwner: true,
      }],
    },
  });
  const selfMessage = normalizeTelegramBridgeEvent({
    type: "message",
    message_id: "42:1",
    chat_type: "private",
    chat_id: "tg:42",
    sender_id: "tg:42",
    self_id: "tg:42",
    text: "hello",
    self_conversation: true,
    exact_self_chat: true,
  }, config.telegram.sources[0]);
  const stranger = {
    ...selfMessage,
    messageId: "99:1",
    chatId: "tg:99",
    senderId: "tg:99",
    selfConversation: false,
    exactSelfChat: false,
    direction: "incoming",
  };

  assert.equal(acceptedMessage(selfMessage, config).accepted, true);
  assert.equal(
    requesterAccess(selfMessage, new Set(), config),
    "owner",
  );
  assert.equal(
    acceptedMessage(stranger, config).reason,
    "sender-not-allowed",
  );
  assert.equal(requesterAccess(stranger, new Set(), config), "public");
});

test("Telegram outgoing private summons require self identity and keep public access", () => {
  const config = loadConfig({}, {
    telegram: { sources: [{
      id: "tg-main",
      sessionPath: "/tmp/telegram.session",
      allowSelf: true,
      listenSelf: true,
      trustSelfAsOwner: true,
      botNames: ["Webot"],
      triggerKeywords: ["helper"],
    }] },
  });
  const message = normalizeTelegramBridgeEvent({
    type: "message", message_id: "99:7",
    chat_type: "private", chat_id: "tg:99",
    sender_id: "tg:42", self_id: "tg:42",
    direction: "outgoing", text: "@webot help",
  }, config.telegram.sources[0]);
  assert.deepEqual(acceptedMessage(message, config), {
    accepted: true, text: "help",
  });
  assert.equal(requesterAccess(message, new Set(), config), "public");
  assert.equal(message.replyTarget, "tg:99");
  assert.equal(acceptedMessage({ ...message, text: "helper help" }, config).accepted, true);
  for (const changes of [
    { text: "hello" }, { text: "@webotany help" },
    { senderId: "tg:12" }, { selfId: "" }, { chatType: "group" },
    { text: "【AI】@webot help" },
  ]) {
    assert.equal(acceptedMessage({ ...message, ...changes }, config).accepted, false);
  }
  const incoming = { ...message, direction: "incoming", senderId: "tg:99" };
  assert.equal(acceptedMessage(incoming, config).accepted, true);
  assert.equal(requesterAccess(incoming, new Set(), config), "public");
  const configured = config.telegram.sources[0];
  configured.blockedChatIds.add("tg:99");
  assert.equal(acceptedMessage(message, config).reason, "chat-blocked");
  configured.blockedChatIds.clear();
  configured.allowSelf = false;
  assert.equal(acceptedMessage(message, config).accepted, false);
  configured.allowSelf = true;
  configured.listenSelf = false;
  assert.equal(acceptedMessage(message, config).accepted, false);
});

test("Python bridge preserves private self summons and rejects echoes offline", async () => {
  await promisify(execFile)("python3", [
    "-B", "test/telegram_bridge_test.py",
  ], { cwd: path.resolve(import.meta.dirname, "..") });
});

test("Telegram transport sends text and files through its source bridge", async () => {
  const calls = [];
  const configuredSource = source();
  const client = {
    source: configuredSource,
    async request(payload) {
      calls.push(payload);
      return { ok: true, message_id: calls.length };
    },
  };
  const transport = new TelegramTransport(
    { sources: [configuredSource] },
    "live",
  );
  transport.setClients([client]);

  await transport.send({
    sourceId: "tg-main",
    chatType: "group",
    chatId: "tg:-1001",
    telegramMessageId: 7,
  }, "reply");

  assert.deepEqual(calls[0], {
    action: "send_message",
    chat_id: "tg:-1001",
    text: "reply",
    reply_to: 7,
  });
});

test("Telegram transport downloads deferred inbound images through the bridge", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-telegram-media-"));
  const configuredSource = source();
  const calls = [];
  const client = {
    source: configuredSource,
    async request(payload) {
      calls.push(payload);
      await fs.writeFile(payload.path, Buffer.from("image-bytes"));
      return { ok: true, mime: "image/jpeg", size: 11 };
    },
  };
  const transport = new TelegramTransport(
    { sources: [configuredSource] },
    "live",
  );
  transport.setClients([client]);

  const result = await transport.downloadInboundAttachment({
    sourceId: "tg-main",
    chatId: "tg:42",
  }, {
    kind: "image",
    filename: "photo.jpg",
    mime: "image/jpeg",
    downloadContext: {
      type: "telegram",
      chatId: "tg:42",
      messageId: 10,
    },
  }, directory);

  assert.equal(calls[0].action, "download_media");
  assert.equal(calls[0].chat_id, "tg:42");
  assert.equal(calls[0].message_id, 10);
  assert.equal(result.mime, "image/jpeg");
  assert.deepEqual(await fs.readFile(result.localPath), Buffer.from("image-bytes"));
});

test("Telegram bridge client parses ready, inbound, and request responses", async (context) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = context.mock.fn();
  const inbound = [];
  const client = new TelegramBridgeClient(
    source(),
    (message) => inbound.push(message),
    { info() {}, warn() {}, error() {} },
    {
      spawnImpl: (_bin, _args, options) => {
        assert.deepEqual(
          JSON.parse(options.env.TG_SELF_COMMAND_PREFIXES),
          ["webot", "Webot"],
        );
        return child;
      },
    },
  );
  client.start();
  child.stdout.write(`${JSON.stringify({
    type: "ready",
    self_id: "tg:42",
    account_type: "user",
  })}\n`);
  assert.equal(client.status().connected, true);

  child.stdout.write(`${JSON.stringify({
    type: "message",
    message_id: "42:2",
    telegram_message_id: 2,
    chat_type: "private",
    chat_id: "tg:42",
    sender_id: "tg:42",
    self_id: "tg:42",
    text: "ping",
    self_conversation: true,
    exact_self_chat: true,
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inbound.length, 1);

  const response = client.request({
    action: "send_message",
    chat_id: "tg:42",
    text: "pong",
  });
  const command = JSON.parse(child.stdin.read().toString());
  child.stdout.write(`${JSON.stringify({
    type: "response",
    id: command.id,
    ok: true,
    message_id: 3,
  })}\n`);
  assert.equal((await response).message_id, 3);
  client.stop();
});
