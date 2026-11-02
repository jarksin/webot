import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";
import { WebotApplication } from "../src/application.js";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-clear-"));
  const caseStore = new CaseStore(path.join(directory, "cases.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"));
  const config = loadConfig({}, {
    caseManagement: { autoRun: false, autoSend: false },
    assistant: { codexModel: "gpt-6.1-sol" },
    pad: { sources: [{ id: "small", selfId: "bot", ignoreAllowlist: true }] },
  });
  const requests = [];
  const manager = new CaseManager({ config, caseStore, sessionStore,
    provider: { async reply(request) { requests.push(request); return { text: "done" }; } },
    transports: { pad: { send() { assert.fail("Clear must not send a WeChat message"); } } },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => { manager.stopAll(); caseStore.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const message = (id) => ({ transport: "pad", sourceId: "small", selfId: "bot",
    chatType: "private", chatId: "customer", senderId: "customer", direction: "incoming",
    messageId: id, text: id, timestamp: Date.now() });
  return { manager, caseStore, sessionStore, config, message, requests };
}

test("admin Clear discards pending context and overrides, retains records/backend, and prevents old task replay", async (t) => {
  const { manager, caseStore, sessionStore, message, requests, config } = await fixture(t);
  const old = message("old task");
  const { caseId } = await manager.receive(old);
  caseStore.db.prepare("update worker_sessions set codex_session_id='old-session', model='company-gpt-6.1-sol' where case_id=?").run(caseId);
  caseStore.setRuntimeSetting(`assistant_model:${caseId}`, "company-gpt-6.1-sol");
  caseStore.setRuntimeSetting(`assistant_effort:${caseId}`, "low");
  caseStore.setRuntimeSetting(`assistant_backend:${caseId}`, "default");
  manager.queue.push(caseId);
  const result = await manager.clearContext(caseId);
  assert.match(result.text, /已清理当前会话/);
  assert.deepEqual(await sessionStore.history(caseId), []);
  assert.equal(caseStore.workerSession(caseId).codex_session_id, "");
  assert.equal(caseStore.runtimeSetting(`assistant_model:${caseId}`, ""), "");
  assert.equal(caseStore.runtimeSetting(`assistant_effort:${caseId}`, ""), "");
  assert.equal(caseStore.runtimeSetting(`assistant_backend:${caseId}`, ""), "default");
  assert.equal(caseStore.detail(caseId).messages.length, 1);
  assert.equal(caseStore.pendingMessages(caseId, caseStore.workerSession(caseId).last_processed_message_id).length, 0);
  assert.equal(manager.queue.length, 0);
  manager.forced.add(caseId);
  await manager.run(caseId);
  assert.equal(requests.length, 0);
  await manager.receive(message("new task"));
  await manager.run(caseId);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message.text, "new task");
  assert.equal(requests[0].history.some((item) => item.content === "old task"), false);

  caseStore.deleteRuntimeSetting(`assistant_backend:${caseId}`);
  const app = new WebotApplication({});
  app.caseStore = caseStore;
  app.config = config;
  const detail = app.caseDetail(caseId);
  assert.equal(detail.nextRuntime.model, "gpt-6.1-sol");
  assert.equal(detail.nextRuntime.modelSource, "default");
});

test("admin Clear refuses an active worker before modifying anything", async (t) => {
  const { manager, caseStore, sessionStore, message } = await fixture(t);
  const { caseId } = await manager.receive(message("task"));
  manager.running.set(caseId, { controller: new AbortController() });
  await assert.rejects(manager.clearContext(caseId), /先停止 Worker/);
  assert.notDeepEqual(await sessionStore.history(caseId), []);
  assert.equal(caseStore.runtimeSetting(`context_clear_cursor:${caseId}`, ""), "");
  manager.running.delete(caseId);
});

test("Clear media boundary prevents old images from returning as context", async (t) => {
  const { manager, caseStore, message } = await fixture(t);
  const old = { ...message("old-image"), timestamp: 1000, attachments: [{ kind: "image", path: "/tmp/old.png" }] };
  caseStore.ingestSyncedMessage(old);
  const { caseId } = await manager.receive(old);
  await manager.clearContext(caseId);
  const fresh = { ...message("new-image"), timestamp: 2000, attachments: [{ kind: "image", path: "/tmp/new.png" }] };
  caseStore.ingestSyncedMessage(fresh);
  const context = caseStore.mediaContextBefore({ ...message("next"), timestamp: 3000 }, { caseId, afterMessageId: old.messageId });
  assert.deepEqual(context.map((entry) => entry.message.messageId), [fresh.messageId]);
});
