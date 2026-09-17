import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
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
    { spawnImpl: () => child },
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
