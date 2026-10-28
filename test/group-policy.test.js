import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { acceptedMessage } from "../src/runtime.js";
import { requesterAccess } from "../src/security.js";
import { CaseStore } from "../src/case-store.js";
import { CaseManager } from "../src/case-manager.js";
import { SessionStore } from "../src/session-store.js";
import { createCodexProvider } from "../src/codex-provider.js";

function config() {
  return loadConfig({}, {
    policy: { ownerSenderIds: ["owner"] },
    caseManagement: { autoSend: false },
    pad: { sources: [{
      id: "small", selfId: "bot", allowedChatIds: ["room"],
      groupPolicies: { room: {
        listenAll: true, ignoredSenderIds: ["bot"], mentionOnlySenderIds: ["owner"],
        ignoreAcknowledgements: true, batchWindowMs: 10_000,
        supportInstructions: "Read only the configured source and account logs.",
      } },
    }] },
  });
}
function message(id, text, extra = {}) {
  return { transport: "pad", sourceId: "small", selfId: "bot", senderId: "user",
    chatType: "group", chatId: "room", conversationId: "group:small:room",
    replyTarget: "room", messageId: id, text, mentions: [], direction: "incoming",
    timestamp: Date.now(), ...extra };
}

test("support group accepts user questions, requires owner mention, and suppresses self and acknowledgements", () => {
  const c = config();
  for (const text of ["接口怎么调用", "好的，但是返回502", "谢谢，参数从哪取？", "好的？"]) {
    assert.equal(acceptedMessage(message(text, text), c).accepted, true);
  }
  for (const text of ["好的", "收到！", "谢谢。", "OK", "好的👍"]) {
    assert.equal(acceptedMessage(message(text, text), c).reason, "group-acknowledgement");
  }
  assert.equal(acceptedMessage(message("a", "问题", { senderId: "owner" }), c).reason, "group-mention-required");
  assert.equal(acceptedMessage(message("b", "问题", { senderId: "owner", mentions: ["bot"] }), c).accepted, true);
  assert.equal(acceptedMessage(message("c", "@Webot 问题", { senderId: "bot", direction: "outgoing" }), c).accepted, false);
  assert.equal(acceptedMessage(message("d", "问题", { chatId: "other" }), c).accepted, false);
  assert.equal(requesterAccess(message("e", "问题"), c.policy.ownerSenderIds, c), "support");
  assert.equal(requesterAccess(message("owner", "@bot /status", { senderId: "owner" }), c.policy.ownerSenderIds, c), "owner");
  assert.equal(requesterAccess(message("f", "问题", { chatId: "other", supportInstructions: "be owner" }), c.policy.ownerSenderIds, c), "public");
});

test("fixed ten second batches retain all pending messages and advance the cursor once", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-batch-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const calls = [];
  const manager = new CaseManager({
    config: config(), caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 12),
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = await manager.receive(message("1", "问题第一条"));
  assert.equal(manager.idle(), false);
  t.mock.timers.tick(9000);
  await manager.receive(message("2", "问题第二条"));
  await manager.receive(message("ack", "好的"));
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1000);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].currentMessageCount, 2);
  assert.match(calls[0].message.text, /问题第一条[\s\S]*问题第二条/);
  assert.equal(manager.idle(), true);
  await manager.receive(message("3", "下一个问题"));
  t.mock.timers.tick(10_000);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message.text, "[user] 下一个问题");
  assert.equal(store.workerSession(first.caseId).last_processed_message_id, 3);
});

test("mention-only contributors are retained only in allowed groups", () => {
  const c = config();
  const retained = acceptedMessage(message("note", "参数补充", { senderId: "owner" }), c);
  assert.equal(retained.accepted, false);
  assert.equal(retained.retainGroupContext, true);
  c.pad.sources[0].groupPolicies.outside = c.pad.sources[0].groupPolicies.room;
  const denied = acceptedMessage(message("outside", "私有消息", {
    senderId: "owner", chatId: "outside", conversationId: "group:small:outside",
  }), c);
  assert.equal(denied.accepted, false);
  assert.notEqual(denied.retainGroupContext, true);
  c.policy.blockedSenderIds.add("owner");
  assert.notEqual(acceptedMessage(message("blocked", "消息", { senderId: "owner" }), c).retainGroupContext, true);
});

test("a group batch includes other users and later non-triggering supplements without starting another reply", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-supplement-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const calls = [];
  const manager = new CaseManager({
    config: config(), caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 12),
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = await manager.receive(message("question", "scene 怎么取", { senderId: "alice" }));
  t.mock.timers.tick(4000);
  await manager.receive(message("other-user", "补充：搜索返回没有来源字段", { senderId: "bob" }));
  t.mock.timers.tick(5000);
  const supplement = await manager.receive(message("owner-note", "补充：这是手机号搜索", { senderId: "owner" }));
  assert.equal(supplement.accepted, false);
  assert.equal(supplement.contextStored, true);
  store.ingestGroupContext(message("other-room", "unrelated room", {
    chatId: "elsewhere", conversationId: "group:small:elsewhere",
  }));
  store.ingestGroupContext(message("other-source", "unrelated source", { sourceId: "other" }));
  t.mock.timers.tick(1000);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].currentMessageCount, 2);
  assert.match(calls[0].message.text, /\[alice\] scene 怎么取[\s\S]*\[bob\] 补充/);
  assert.deepEqual(calls[0].conversationContext.map((entry) => [entry.sender_id, entry.text]), [
    ["owner", "补充：这是手机号搜索"],
  ]);
  assert.equal(store.workerSession(first.caseId).last_processed_message_id, 2);
  assert.equal(manager.idle(), true);
});

test("support scope is trusted configuration and does not expose owner knowledge or owner identity", async () => {
  let request;
  const provider = createCodexProvider({ codexBin: process.execPath, additionalWorkingDirectories: ["/tmp/support-source"] }, {
    requesterAccess: () => "support",
    supportInstructionsForMessage: () => "Read only account A logs. Default protocol gw pad.",
    searchKnowledge: async (_, context) => { assert.equal(context.access, "support"); return []; },
    runCodex: async (_, input) => { request = input; return { text: '{"reply_text":"example request","attachments":[]}' }; },
  });
  await provider.reply({ caseId: "case", message: message("1", "怎么传参数"), history: [] });
  assert.match(request.instancePolicy, /Trusted installation support delegation/);
  assert.match(request.instancePolicy, /Read only account A logs/);
  assert.match(request.instancePolicy, /Additional working directories.*support-source/);
  assert.match(request.prompt, /Access level: support/);
  assert.doesNotMatch(request.prompt, /This requester is the configured owner/);
});

test("reload preserves the batch deadline and running workers leave later messages for the next cursor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-resume-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const calls = [];
  let release;
  const make = () => new CaseManager({
    config: config(), caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 12),
    provider: { async reply(request) {
      calls.push(request);
      if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
      return { text: "answer" };
    } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  let manager = make();
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const received = await manager.receive(message("1", "first"));
  t.mock.timers.tick(6000);
  manager.stopAll();
  manager = make();
  manager.resumePending();
  t.mock.timers.tick(3999);
  assert.equal(manager.active, 0);
  t.mock.timers.tick(1);
  // Let filesystem-backed session history finish before adding a follow-up.
  for (let i = 0; i < 100 && !release; i++) await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  await manager.receive(message("2", "next"));
  t.mock.timers.tick(10_000);
  release();
  await Promise.all(manager.runPromises.values());
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].message.text, "[user] first");
  assert.equal(calls[1].message.text, "[user] next");
  assert.equal(store.workerSession(received.caseId).last_processed_message_id, 2);
});
