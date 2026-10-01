import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaseManager } from "../src/case-manager.js";
import { WebotApplication } from "../src/application.js";
import { CaseStore } from "../src/case-store.js";
import { loadConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import { createSourceActivator } from "../src/source-activation.js";

function fixture() {
  const starts = [];
  const running = new Map();
  const manager = new CaseManager({
    config: { caseManagement: { workerConcurrency: 2 } },
    caseStore: {
      runtimeSetting: () => "0",
      caseRow: () => ({}),
      addProgress() {},
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  manager.run = (caseId) => {
    starts.push(caseId);
    return new Promise((resolve) => running.set(caseId, resolve));
  };
  const app = Object.create(WebotApplication.prototype);
  app.caseManager = manager;
  return { manager, app, starts, running };
}

async function finish(f, caseId) {
  const promise = f.manager.runPromises.get(caseId);
  f.running.get(caseId)();
  await promise;
}

test("busy restart requests never prevent a newly queued task from starting", async () => {
  const f = fixture();
  f.manager.enqueue("old-task");
  const status = f.app.beginWorkerDrain();
  assert.equal(status.draining, false);
  assert.equal(status.active, 1);
  f.manager.enqueue("telegram-task");
  assert.deepEqual(f.starts, ["old-task", "telegram-task"]);
  assert.equal(f.manager.reserveIdle(), null);
  await finish(f, "old-task");
  assert.equal(f.manager.idle(), false);
  await finish(f, "telegram-task");
  assert.equal(f.manager.idle(), true);
});

test("queued work and reruns also prevent an idle restart reservation", () => {
  const f = fixture();
  f.manager.queue.push("telegram-task");
  assert.equal(f.manager.reserveIdle(), null);
  assert.equal(f.manager.draining, false);
  f.manager.queue = [];
  f.manager.rerun.add("follow-up");
  assert.equal(f.manager.reserveIdle(), null);
});

test("a restart reservation never overrides an explicit worker pause", () => {
  const f = fixture();
  f.manager.caseStore.runtimeSetting = () => "1";
  const reservation = f.manager.reserveIdle();
  f.manager.enqueue("paused-task");
  reservation.release();
  assert.equal(f.manager.paused(), true);
  assert.equal(f.manager.draining, false);
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.manager.queue, ["paused-task"]);
});

test("an abandoned restart lease releases scheduling and runs queued tasks", async () => {
  const f = fixture();
  let expire;
  const reservation = f.manager.reserveIdle({
    schedule(callback) { expire = callback; return { unref() {} }; },
    cancel() {},
  });
  assert.ok(reservation);
  assert.equal(f.manager.draining, true);
  f.manager.enqueue("telegram-task");
  assert.equal(f.starts.length, 0);
  expire();
  assert.equal(f.manager.draining, false);
  assert.deepEqual(f.starts, ["telegram-task"]);
  await finish(f, "telegram-task");
});

test("new queued work wins a race against the external broker's drain request", async () => {
  const f = fixture();
  const reservation = f.manager.reserveIdle();
  f.manager.enqueue("telegram-task");
  const status = f.app.beginWorkerDrain();
  assert.equal(status.draining, false);
  assert.equal(status.active, 1);
  assert.deepEqual(f.starts, ["telegram-task"]);
  reservation.release();
  await finish(f, "telegram-task");
});

test("stopped queued cases are not resurrected when a restart lease expires", () => {
  const f = fixture();
  const reservation = f.manager.reserveIdle();
  f.manager.enqueue("stopped-task");
  assert.equal(f.manager.stop("stopped-task"), false);
  reservation.release();
  assert.equal(f.manager.queue.length, 0);
  assert.equal(f.starts.length, 0);
});

test("an explicit drain release leaves worker pause settings unchanged", async () => {
  const f = fixture();
  f.manager.reserveIdle();
  f.manager.enqueue("telegram-task");
  const status = f.app.beginWorkerDrain({ draining: false });
  assert.equal(status.draining, false);
  assert.equal(status.paused, false);
  await finish(f, "telegram-task");
});

test("Telegram follow-ups reach a real worker and draft while a reload waits", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-idle-telegram-"));
  const caseStore = new CaseStore(path.join(directory, "cases.sqlite"));
  const config = loadConfig({ WEBOT_CHANNELS: "telegram" }, {
    caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
    telegram: { sources: [{
      id: "fixture", enabled: true, allowSelf: true, listenSelf: true,
      allowedSenderIds: ["tg:owner"],
    }] },
  });
  const replies = new Map();
  const manager = new CaseManager({
    config, caseStore,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    provider: {
      reply: ({ message }) => new Promise((resolve) => replies.set(message.text, resolve)),
    },
    transports: {},
    requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    manager.stopAll();
    for (const resolve of replies.values()) resolve("cleanup");
    await Promise.all(manager.runPromises.values());
    caseStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function waitFor(check) {
    const deadline = Date.now() + 2000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error("worker condition not met");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const message = (id, text) => ({
    transport: "telegram", sourceId: "fixture", messageId: id,
    chatId: "tg:owner", senderId: "tg:owner", selfId: "tg:owner",
    chatType: "private", direction: "incoming", exactSelfChat: true,
    selfConversation: true, text, mentions: [], timestamp: Date.now(),
  });
  const callbacks = [];
  let submissions = 0;
  const activator = createSourceActivator({
    idle: () => manager.idle(),
    reserveIdle: () => manager.reserveIdle(),
    candidate: async () => ({ version: "0.6.42", revision: "a".repeat(40) }),
    schedule(callback) { callbacks.push(callback); return {}; },
    fetchImpl: async () => {
      submissions++;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  const first = await manager.receive(message("first", "first-task"));
  await waitFor(() => replies.has("first-task"));
  const reload = await activator.activate({ caseId: "reload", sourceId: "fixture" });
  assert.equal(reload.reason, "waiting-for-idle");
  assert.equal(manager.draining, false);
  await manager.receive(message("follow-up", "follow-up-task"));
  replies.get("first-task")("first reply");
  await waitFor(() => replies.has("follow-up-task"));
  assert.equal(manager.draining, false);
  assert.equal(submissions, 0);
  replies.get("follow-up-task")("follow-up reply");
  await waitFor(() => manager.idle());
  assert.equal(caseStore.detail(first.caseId).drafts.length, 2);
  await callbacks.shift()();
  assert.equal(submissions, 1);
  manager.idleDrain.release();
});
