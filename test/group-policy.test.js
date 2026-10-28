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
