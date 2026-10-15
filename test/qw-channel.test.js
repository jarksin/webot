import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePadEnvelope } from "../src/normalize.js";
import { PadSenderClassifier } from "../src/pad-sender-classifier.js";
import { PadTransport } from "../src/transports/pad.js";
import { WebotApplication } from "../src/application.js";
import { SettingsStore } from "../src/settings-store.js";
import { CaseStore } from "../src/case-store.js";
import { requesterAccess } from "../src/security.js";

const source = {
  id: "qw", displayName: "QW", selfId: "9007199254740993",
  enabled: true, strictPolicy: true, ignoreAllowlist: true,
  apiUrl: "https://gateway.invalid/api", wsUrl: "wss://gateway.invalid/ws/account",
  accessToken: "test-secret", keywordOnly: true, triggerKeywords: ["@webot"],
};

function frame(extra = {}) {
  return {
    schema: "qw.message.v1", protocol: "qw_pad", wxid: source.selfId,
    messages: [{
      id: "9007199254740995", sequence: "1", kind: "text", direction: "incoming",
      conversation_id: "9007199254740997", sender_id: "9007199254740997",
      recipient_id: source.selfId, content: "@webot hello", created_at: 1767225600,
      is_group: false, ...extra,
    }],
  };
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-qw-channel-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("QW schema preserves text kind, exact IDs, literal content and group routing", () => {
  const [message] = normalizePadEnvelope(frame(), source);
  assert.equal(message.messageType, 1);
  assert.equal(message.messageKind, "text");
  assert.equal(message.protocol, "qw_pad");
  assert.equal(message.messageId, "9007199254740995");
  assert.equal(message.senderId, "9007199254740997");
  assert.equal(message.chatId, "9007199254740997");
  assert.equal(message.timestamp, 1767225600000);
  const content = "<msg><op>literal user text</op></msg>";
  const [literal] = normalizePadEnvelope(frame({ content }), source);
  assert.equal(literal.text, content);
  assert.equal(literal.app, undefined);
  assert.equal(literal.reference, null);
  const [group] = normalizePadEnvelope(frame({
    is_group: true, conversation_id: "18446744073709551615",
  }), source);
  assert.equal(group.chatType, "group");
  assert.equal(group.senderId, message.senderId);
  assert.equal(group.replyTarget, "18446744073709551615");
  assert.equal(group.conversationId, "group:qw:18446744073709551615");
});

test("QW text bypasses personal contact probes without permitting unknown kinds or granting owner", async () => {
  const classifier = new PadSenderClassifier({ sources: [source] }, {
    fetchImpl: async () => { throw new Error("personal contact API must not be called"); },
  });
  const [message] = normalizePadEnvelope(frame(), source);
  assert.equal((await classifier.classify(message)).blocked, false);
  assert.equal(requesterAccess(message, new Set(["owner"])), "public");
  for (const kind of ["image", "video", "voice", "unknown", ""]) {
    const [other] = normalizePadEnvelope(frame({ kind, type: 1 }), source);
    assert.equal(other.messageType, null);
    assert.equal((await classifier.classify(other)).reason, "unsupported-message-type");
  }
  const unscoped = frame();
  delete unscoped.schema;
  const [other] = normalizePadEnvelope(unscoped, source);
  assert.equal(other.protocol, undefined);
  assert.equal((await classifier.classify(other)).reason, "unsupported-message-type");
});

test("QW text replies use the confirmed product API without personal Pad-only fields", async () => {
  const calls = [];
  const transport = new PadTransport({ sources: [source] }, "live", console, async (url, options) => {
    calls.push({ url, options });
    return Response.json({ Code: 0, Success: true, Data: { msg_id: 7 } });
  });
  for (const isGroup of [false, true]) {
    const [message] = normalizePadEnvelope(frame({
      is_group: isGroup, conversation_id: isGroup ? "100" : "9007199254740997",
    }), source);
    assert.equal((await transport.send(message, "reply")).ok, true);
    const call = calls.at(-1);
    assert.equal(call.url, "https://gateway.invalid/api/v1/messages/send-text");
    const body = JSON.parse(call.options.body);
    assert.equal(body.to, isGroup ? "100" : "9007199254740997");
    assert.equal(body.content, "reply");
    assert.equal(body.is_room, isGroup);
    assert.equal(body.confirm, true);
    assert.ok(body.request_id.length >= 8);
    assert.equal(body.type, undefined);
    assert.equal(body.at, undefined);
    assert.equal(call.options.headers["X-Access-Token"], "test-secret");
  }
  assert.notEqual(JSON.parse(calls[0].options.body).request_id,
    JSON.parse(calls[1].options.body).request_id);
});

test("keyword-only QW ingress creates a worker and sent draft exactly once", async (t) => {
  const directory = await temporary(t);
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.load();
  await settingsStore.save({
    channels: ["pad"], outboundMode: "live",
    assistant: { mode: "echo" }, pad: { sources: [source] },
    caseManagement: { autoRun: true, autoSend: true },
  });
  const calls = [];
  const app = new WebotApplication({
    env: { WEBOT_DATA_DIR: directory }, settingsStore,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json({ Code: 0, Success: true, Data: { msg_id: 7 } });
    },
  });
  await app.initialize();
  t.after(async () => {
    await app.stopConnectors();
    app.caseStore.close();
  });
  const [ignored] = normalizePadEnvelope(frame({ id: "1", content: "hello" }), source);
  assert.equal((await app.receive(ignored)).reason, "private-not-triggered");
  assert.equal(app.caseStore.casePage().total, 0);
  const [message] = normalizePadEnvelope(frame(), source);
  const accepted = await app.receive(message);
  assert.equal(accepted.accepted, true);
  await Promise.all([...app.caseManager.runPromises.values()]);
  const detail = app.caseStore.detail(accepted.caseId);
  assert.equal(detail.workerSession.run_count, 1);
  assert.equal(detail.drafts.length, 1);
  assert.equal(detail.drafts[0].status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to, message.senderId);
  assert.match(calls[0].body.content, /hello/);
  assert.equal((await app.receive(message)).reason, "duplicate");
  assert.equal(calls.length, 1);
  assert.equal(app.caseStore.syncedMessageByMessageId("qw", message.messageId).accepted, true);
});

test("a scoped replay store leaves other live workers untouched", async (t) => {
  const directory = await temporary(t);
  const file = path.join(directory, "case.sqlite");
  const store = new CaseStore(file);
  t.after(() => store.close());
  const [message] = normalizePadEnvelope(frame(), source);
  const ingested = store.ingest(message);
  store.startRun(ingested.caseId, ingested.messageRow);
  const before = store.workerSession(ingested.caseId);
  const replay = new CaseStore(file, { recoverInterruptedRuns: false });
  try {
    assert.deepEqual(replay.workerSession(ingested.caseId), before);
    assert.equal(replay.caseRow(ingested.caseId).status, "running");
  } finally {
    replay.close();
  }
});
