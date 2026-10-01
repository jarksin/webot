import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { loadConfig } from "../src/config.js";
import { SessionStore } from "../src/session-store.js";
import { WebotApplication } from "../src/application.js";

async function waitFor(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("worker condition not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("manual restart stops persisted tasks without replaying them and retains new messages", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-manual-restart-"));
  const store = new CaseStore(path.join(directory, "cases.sqlite"));
  const config = loadConfig({ WEBOT_CHANNELS: "telegram" }, {
    caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
    telegram: { sources: [{
      id: "fixture", enabled: true, allowSelf: true, listenSelf: true,
      allowedSenderIds: ["tg:owner"],
    }] },
  });
  const replies = new Map();
  const starts = [];
  const manager = new CaseManager({
    config, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    provider: {
      reply: ({ message, signal }) => new Promise((resolve) => {
        starts.push(message.text);
        replies.set(message.text, { resolve, signal });
      }),
    },
    transports: {}, requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    manager.stopAll();
    for (const { resolve } of replies.values()) resolve("cleanup");
    await Promise.all(manager.runPromises.values());
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const message = (id, text, chatId = "tg:owner") => ({
    transport: "telegram", sourceId: "fixture", messageId: id,
    chatId, senderId: "tg:owner", selfId: "tg:owner",
    chatType: "private", direction: "incoming", exactSelfChat: true,
    selfConversation: true, text, mentions: [], timestamp: Date.now(),
  });
  const first = await manager.receive(message("first", "cancel-me"));
  await waitFor(() => replies.has("cancel-me"));
  const queued = await manager.receive(message("queued", "queued-task", "tg:other"));
  const app = Object.create(WebotApplication.prototype);
  app.caseManager = manager;
  const stopped = app.beginWorkerDrain({ stopRunning: true });
  assert.equal(stopped.draining, true);
  assert.equal(replies.get("cancel-me").signal.aborted, true);
  assert.equal(store.caseRow(first.caseId).status, "stopped");
  assert.equal(store.pendingCaseIds().includes(first.caseId), false);
  assert.equal(store.pendingCaseIds().includes(queued.caseId), true);
  const processed = store.workerSession(first.caseId).last_processed_message_id;
  assert.ok(processed > 0);
  await manager.receive(message("follow-up", "new-follow-up"));
  assert.equal(store.caseRow(first.caseId).status, "new");
  const reservation = manager.idleDrain;
  app.beginWorkerDrain({ stopRunning: true });
  assert.equal(manager.idleDrain, reservation);
  assert.equal(store.workerSession(first.caseId).last_processed_message_id, processed);
  assert.equal(manager.reserveIdle(), null);
  replies.get("cancel-me").resolve("must not become a draft");
  await waitFor(() => manager.active === 0);
  assert.equal(store.detail(first.caseId).drafts.length, 0);
  assert.equal(store.caseRow(first.caseId).status, "new");
  assert.deepEqual(starts, ["cancel-me"]);
  app.beginWorkerDrain({ draining: false });
  await waitFor(() => replies.has("queued-task"));
  replies.get("queued-task").resolve("queued reply");
  await waitFor(() => replies.has("new-follow-up"));
  replies.get("new-follow-up").resolve("follow-up reply");
  await waitFor(() => manager.idle());
  assert.deepEqual(starts, ["cancel-me", "queued-task", "new-follow-up"]);
  assert.equal(store.detail(first.caseId).drafts.length, 1);
  assert.equal(store.detail(queued.caseId).drafts.length, 1);
  assert.equal(store.pendingCaseIds().length, 0);
});
