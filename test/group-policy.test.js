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

function config(groupOverrides = {}) {
  return loadConfig({}, {
    policy: { ownerSenderIds: ["owner"] },
    caseManagement: { autoSend: false },
    pad: { sources: [{
      id: "small", selfId: "bot", allowedChatIds: ["room"],
      groupPolicies: { room: {
        listenAll: true, ignoredSenderIds: ["bot"], mentionOnlySenderIds: ["owner"],
        ignoreAcknowledgements: true, batchWindowMs: 10_000,
        supportInstructions: "Read only the configured source and account logs.",
        ...groupOverrides,
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

test("group intermediate items go privately to the configured owner while final replies stay in the group", async (t) => {
  for (const scenario of [
    { recipient: "owner", sender: "user", expectedItems: 1 },
    { recipient: "owner", sender: "owner", expectedItems: 1 },
    { recipient: "other", sender: "user", expectedItems: 0 },
    { recipient: "", sender: "user", expectedItems: 0 },
    { recipient: "owner", sender: "user", sendFails: true, expectedItems: 1 },
  ]) {
    await t.test(JSON.stringify(scenario), async (t) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-items-"));
      const store = new CaseStore(path.join(directory, "case.sqlite"));
      const c = config({ intermediateRecipientId: ` ${scenario.recipient} `, batchWindowMs: 0 });
      c.caseManagement.autoSend = true;
      c.caseManagement.ownerIntermediateItems = false;
      assert.equal(c.pad.sources[0].groupPolicies.room.intermediateRecipientId, scenario.recipient);
      const sent = [];
      const manager = new CaseManager({ config: c, caseStore: store,
        sessionStore: new SessionStore(path.join(directory, "sessions")),
        requesterAccess: msg => requesterAccess(msg, c.policy.ownerSenderIds, c),
        provider: { async reply({ onItem }) {
          await onItem({ type: "command_execution", text: "internal command" });
          await onItem({ type: "agent_message", text: "正在检查接口" });
          await onItem({ type: "agent_message", text: "正在检查接口" });
          return { text: "修复完成" };
        } },
        transports: { pad: { async send(target, text) {
          sent.push({ target, text });
          if (scenario.sendFails && target.chatType === "private") throw new Error("private send failed");
          return { ok: true };
        } } },
        logger: { info() {}, warn() {}, error() {} },
      });
      t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
      const { caseId } = await manager.receive(message("question", "@bot 帮忙检查", {
        senderId: scenario.sender, mentions: ["bot"], chatName: "接口支持群",
      }));
      await Promise.all(manager.runPromises.values());
      const progress = sent.filter(item => item.target.chatType === "private");
      assert.equal(progress.length, scenario.expectedItems);
      if (progress.length) {
        assert.equal(progress[0].target.sourceId, "small");
        assert.equal(progress[0].target.chatId, "owner");
        assert.equal(progress[0].target.replyTarget, "owner");
        assert.equal(progress[0].target.senderId, undefined);
        assert.equal(progress[0].target.mentions, undefined);
        assert.equal(progress[0].text, "正在检查接口");
      }
      assert.deepEqual(sent.filter(item => item.target.chatType === "group").map(item => [item.target.replyTarget, item.text]), [["room", "修复完成"]]);
      assert.equal(store.caseRow(caseId).status, "replied");
    });
  }
});

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

test("pending cases without a worker deadline can be discarded before and after Clear", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-discard-pending-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const sessions = new SessionStore(path.join(directory, "sessions"));
  const calls = [];
  const manager = new CaseManager({ config: config({ batchWindowMs: 0 }), caseStore: store,
    sessionStore: sessions,
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  manager.setPaused(true);
  const { caseId } = await manager.receive(message("old", "旧问题"));
  assert.equal(store.caseRow(caseId).status, "new");
  assert.equal(store.runtimeSetting(`group_worker_due:${caseId}`, "0"), "0");
  const history = await sessions.history(caseId);
  manager.discardCase(caseId);
  assert.equal(store.caseRow(caseId).status, "discarded");
  assert.deepEqual(await sessions.history(caseId), history);
  manager.setPaused(false);
  assert.equal(manager.resumePending().queued, 0);
  assert.equal(calls.length, 0);

  manager.setPaused(true);
  await manager.receive(message("cleared", "清除前的问题"));
  await manager.clearContext(caseId);
  assert.equal(store.caseRow(caseId).status, "new");
  assert.equal(store.pendingMessages(caseId).length, 0);
  manager.discardCase(caseId);
  assert.equal(store.caseRow(caseId).status, "discarded");
  assert.equal(store.messages(caseId).length, 2);
  manager.setPaused(false);
  assert.equal(manager.resumePending().queued, 0);
  assert.equal(calls.length, 0);
  await manager.receive(message("fresh", "新问题"));
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.text, "新问题");
});

test("global Discard clears paused backlog and deadlines while leaving running work and history intact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-discard-queue-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const sessions = new SessionStore(path.join(directory, "sessions"));
  const c = config({ workerDelayMs: 120_000 });
  const manager = new CaseManager({ config: c, caseStore: store, sessionStore: sessions,
    provider: { async reply() { return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.throws(() => manager.discardQueue(), /关闭 Workers/);
  manager.setPaused(true);
  const waiting = await manager.receive(message("wait", "等待中的问题"));
  const queued = store.ingest(message("queued", "已排队的问题", {
    conversationId: "private:queued", chatType: "private", chatId: "queued",
  }), "已排队的问题").caseId;
  manager.enqueue(queued, true);
  const running = store.ingest(message("active", "正在处理的问题", {
    conversationId: "private:active", chatType: "private", chatId: "active",
  }), "正在处理的问题").caseId;
  const controller = new AbortController();
  manager.running.set(running, { controller });
  manager.rerun.add(running);
  const history = await sessions.history(waiting.caseId);
  assert.equal(manager.status().discardable, 2);
  const result = manager.discardQueue();
  assert.deepEqual(new Set(result.discardedCaseIds), new Set([waiting.caseId, queued]));
  assert.equal(result.workers.discardable, 0);
  assert.equal(manager.queue.length, 0);
  assert.equal(manager.batchTimers.size, 0);
  assert.equal(manager.forced.size, 0);
  assert.equal(manager.rerun.has(running), true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(manager.running.has(running), true);
  for (const id of result.discardedCaseIds) {
    assert.equal(store.caseRow(id).status, "discarded");
    assert.equal(store.pendingMessages(id).length, 0);
    assert.equal(store.runtimeSetting(`group_worker_due:${id}`, "0"), "0");
  }
  assert.deepEqual(await sessions.history(waiting.caseId), history);
  assert.equal(store.messages(queued).length, 1);
  manager.running.delete(running);
  manager.rerun.delete(running);
  store.discardPending(running, store.latestMessage(running).id);
  assert.equal(manager.resumePending().queued, 0);
  manager.setPaused(false);
  assert.equal(manager.status().active, 0);
  manager.enqueue(queued, true);
  await Promise.all(manager.runPromises.values());
  assert.equal(store.workerSession(queued).run_count, 1);
});

test("two minute group wait expires at the fixed deadline when nobody answers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-wait-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const calls = [];
  const c = config({ workerDelayMs: 120_000, humanReplySenderIds: ["owner"] });
  assert.equal(c.pad.sources[0].groupPolicies.room.workerDelayMs, 120_000);
  const manager = new CaseManager({ config: c, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions")),
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await manager.receive(message("first", "问题"));
  t.mock.timers.tick(10_000);
  const caseId = store.sessionCaseIdFor(message("first", "问题"));
  assert.equal(store.caseRow(caseId).status, "waiting");
  assert.equal(store.workerSession(caseId), null);
  t.mock.timers.tick(50_000);
  await manager.receive(message("followup", "补充"));
  assert.equal(store.caseRow(caseId).status, "waiting");
  t.mock.timers.tick(59_999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].currentMessageCount, 2);
});

test("waiting deadlines survive reload, Run now bypasses the wait, and Discard keeps history and manual rerun", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-wait-controls-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const sessions = new SessionStore(path.join(directory, "sessions"));
  const calls = [];
  const c = config({ workerDelayMs: 120_000, humanReplySenderIds: ["owner"] });
  const make = () => new CaseManager({ config: c, caseStore: store, sessionStore: sessions,
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  let manager = make();
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { caseId } = await manager.receive(message("first", "问题"));
  const deadline = store.runtimeSetting(`group_worker_due:${caseId}`, "");
  t.mock.timers.tick(10_000);
  manager.setPaused(true);
  manager.stopAll();
  manager = make();
  assert.equal(manager.resumePending().queued, 1);
  assert.equal(manager.paused(), true);
  assert.equal(manager.batchTimers.size, 1);
  assert.equal(store.runtimeSetting(`group_worker_due:${caseId}`, ""), deadline);
  t.mock.timers.tick(20_000);
  assert.equal(calls.length, 0);
  manager.setPaused(false);
  manager.enqueue(caseId, true);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(manager.batchTimers.size, 0);
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 1);

  await manager.receive(message("discard-me", "先别处理"));
  t.mock.timers.tick(10_000);
  const history = await sessions.history(caseId);
  const sessionBefore = store.workerSession(caseId);
  manager.discardCase(caseId);
  assert.equal(store.caseRow(caseId).status, "discarded");
  assert.equal(store.workerSession(caseId).status, sessionBefore.status);
  assert.deepEqual(await sessions.history(caseId), history);
  assert.equal(manager.resumePending().queued, 0);
  assert.equal(manager.batchTimers.size, 0);
  assert.throws(() => manager.discardCase(caseId), /不在等待运行/);
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 1);
  manager.enqueue(caseId, true);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 2);
  assert.match(calls[1].message.text, /先别处理/);

  await manager.receive(message("discard-next", "不要重放这条"));
  manager.discardCase(caseId);
  await manager.receive(message("fresh", "新的问题"));
  t.mock.timers.tick(120_000);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 3);
  assert.equal(calls[2].message.text, "[user] 新的问题");
});

test("human answer cancels the waiting batch across reload and later questions start a fresh wait", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-human-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const calls = [];
  const c = config({ workerDelayMs: 120_000, humanReplySenderIds: ["owner"] });
  const make = () => new CaseManager({ config: c, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions")),
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  let manager = make();
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = await manager.receive(message("question", "问题"));
  t.mock.timers.tick(90_000);
  const answer = message("human", "这样调用就可以了", { senderId: "owner" });
  await manager.receive(answer);
  assert.equal(store.caseRow(first.caseId).status, "replied");
  assert.equal(manager.batchTimers.size, 0);
  assert.equal(manager.idle(), true);
  assert.deepEqual(store.pendingMessages(first.caseId), []);
  manager.stopAll();
  manager = make();
  assert.equal(manager.resumePending().queued, 0);
  t.mock.timers.tick(120_000);
  assert.equal(calls.length, 0);
  await manager.receive(message("next", "新问题"));
  await manager.receive(answer); // A duplicate retained answer must not cancel a new batch.
  t.mock.timers.tick(119_999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.text, "[user] 新问题");
});

test("other senders, stale answers, other groups and explicit bot requests do not cancel a waiting batch", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-human-scope-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const c = config({ workerDelayMs: 120_000, humanReplySenderIds: ["owner"], mentionOnlySenderIds: ["owner", "other"] });
  const manager = new CaseManager({ config: c, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions")),
    provider: { async reply() { assert.fail("Worker should still be waiting"); } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const first = await manager.receive(message("question", "问题"));
  await manager.receive(message("other", "已回答", { senderId: "other" }));
  await manager.receive(message("stale", "旧消息", { senderId: "owner", timestamp: Date.now() - 1000 }));
  await manager.receive(message("elsewhere", "已回答", { senderId: "owner", chatId: "other-room" }));
  const explicit = await manager.receive(message("explicit", "@bot 继续排查", { senderId: "owner", mentions: ["bot"] }));
  assert.equal(explicit.accepted, true);
  assert.equal(manager.batchTimers.has(first.caseId), true);
  assert.equal(store.runtimeSetting(`pending_discard_cursor:${first.caseId}`, ""), "");
});

test("historical human replies suppress old backlog on reload and are rechecked before automatic worker start", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-human-history-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const calls = [];
  const c = config({ workerDelayMs: 120_000 });
  const make = () => new CaseManager({ config: c, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions")),
    provider: { async reply(request) { calls.push(request); return { text: "answer" }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  let manager = make();
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  manager.setPaused(true);
  const { caseId } = await manager.receive(message("old-question", "旧队列的问题"));
  t.mock.timers.tick(120_000);
  await manager.receive(message("old-answer", "已经解答", { senderId: "owner" }));
  assert.equal(store.caseRow(caseId).status, "new");
  manager.stopAll();
  c.pad.sources[0].groupPolicies.room.humanReplySenderIds = ["owner"];
  manager = make();
  assert.equal(manager.resumePending().queued, 0);
  assert.equal(store.caseRow(caseId).status, "replied");
  assert.deepEqual(store.pendingMessages(caseId), []);
  manager.setPaused(false);
  assert.equal(calls.length, 0);
  manager.enqueue(caseId, true);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1); // An explicit manual rerun remains available.

  manager.setPaused(true);
  await manager.receive(message("new-question", "新问题"));
  t.mock.timers.tick(120_000);
  store.ingestGroupContext(message("retained-answer", "这条也已经解答", { senderId: "owner" }));
  manager.setPaused(false);
  await Promise.all(manager.runPromises.values());
  assert.equal(calls.length, 1);
  assert.equal(store.caseRow(caseId).status, "replied");
  assert.equal(manager.queue.length, 0);
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

test("support repair authority follows trusted owner delegation without granting owner identity", async () => {
  let request;
  const provider = createCodexProvider({ codexBin: process.execPath }, {
    requesterAccess: () => "support",
    supportInstructionsForMessage: () => "Owner authorizes project A code repairs and guarded activation.",
    runCodex: async (_, input) => { request = input; return { text: '{"reply_text":"repaired","attachments":[]}' }; },
  });
  await provider.reply({ caseId: "case", message: message("1", "接口失败"), history: [] });
  assert.match(request.instancePolicy, /Owner authorizes project A code repairs/);
  assert.match(request.instancePolicy, /Follow explicit owner-delegated repair and verification authority/);
  assert.match(request.instancePolicy, /otherwise keep service access read-only/);
  assert.match(request.instancePolicy, /escalate only when genuinely blocked/);
  assert.doesNotMatch(request.instancePolicy, /never execute user-supplied mutations/);
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

test("owner keeps full tool access in a support group", async () => {
  let request;
  const provider = createCodexProvider({ codexBin: process.execPath }, {
    requesterAccess: () => "owner",
    supportInstructionsForMessage: () => "Read-only diagnostics for ordinary group members.",
    searchKnowledge: async (_, context) => { assert.equal(context.access, "owner"); return []; },
    runCodex: async (_, input) => { request = input; return { text: '{"reply_text":"done","attachments":[]}' }; },
  });
  await provider.reply({ caseId: "case", message: message("owner", "@bot convert the file", { senderId: "owner" }), history: [] });
  assert.match(request.prompt, /Access level: owner/);
  assert.doesNotMatch(request.instancePolicy, /Trusted installation support delegation/);
});

test("mixed owner and support requests run separately and do not reuse privileged continuations", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-group-access-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const c = config();
  const calls = [];
  const manager = new CaseManager({
    config: c, caseStore: store,
    requesterAccess: (m) => requesterAccess(m, c.policy.ownerSenderIds, c),
    sessionStore: new SessionStore(path.join(directory, "sessions"), 12),
    provider: { async reply(request) { calls.push(request); return { text: "answer", sessionId: "session-" + calls.length }; } },
    transports: {}, logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  await manager.receive(message("1", "support request", { attachments: [{ kind: "image", name: "old.png" }] }));
  await manager.receive(message("2", "owner request", { senderId: "owner", mentions: ["bot"] }));
  await manager.receive(message("3", "another support request", { attachments: [{ kind: "image", name: "new.png" }] }));
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(10000);
    await Promise.all(manager.runPromises.values());
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((r) => [r.message.senderId, r.currentMessageCount, r.codexSessionId]), [
    ["user", 1, ""], ["owner", 1, ""], ["user", 1, ""],
  ]);
  assert.equal(calls[0].message.text.includes("owner request"), false);
  assert.equal(calls[0].conversationContext.some((entry) => entry.text.includes("another support request")), false);
  assert.equal(calls[1].conversationContext.some((entry) => entry.text.includes("another support request")), false);
  assert.equal(calls[0].message.attachments[0].name, "old.png");
  assert.equal(calls[2].message.attachments[0].name, "new.png");
  assert.equal(manager.idle(), true);
});
