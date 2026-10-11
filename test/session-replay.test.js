import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";

async function fixture(t, access = "owner") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-session-replay-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  const requests = [];
  const config = loadConfig({ WEBOT_DATA_DIR: directory }, {
    identity: { selfId: "self" },
    caseManagement: { autoRun: false, autoSend: false },
    pad: { sources: [{ id: "source", selfId: "self", allowSelf: true }] },
  });
  const manager = new CaseManager({
    config, caseStore, sessionStore,
    requesterAccess: () => access,
    provider: {
      async reply(request) {
        requests.push(request);
        return { text: "done", sessionId: request.codexSessionId || "main-thread" };
      },
    },
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    caseStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const message = (text) => ({
    transport: "pad", sourceId: "source", chatId: "self",
    conversationId: "private:self", senderId: "self", selfId: "self",
    chatType: "private", direction: "incoming",
    selfConversation: true, exactSelfChat: true,
    messageId: `message-${++sequence}`, timestamp: Date.now(), text,
  });
  const force = async (caseId) => {
    manager.forced.add(caseId);
    await manager.run(caseId);
  };
  return { caseStore, sessionStore, manager, requests, message, force };
}

test("forced rerun resumes the task, not a handled session switch", async (t) => {
  const f = await fixture(t);
  const { caseId } = await f.manager.receive(f.message("finish the report"));
  await f.manager.run(caseId);
  await f.manager.receive(f.message("/session new project"));
  const selected = f.caseStore.activeSession(caseId);
  const history = await f.sessionStore.history(caseId);
  await f.force(caseId);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests.at(-1).message.text, "finish the report");
  assert.equal(f.requests.at(-1).codexSessionId, "main-thread");
  assert.equal(f.requests.at(-1).caseId, caseId);
  assert.equal(f.caseStore.activeSession(caseId).session_id, selected.session_id);
  assert.deepEqual(f.requests.at(-1).history, history);
});

test("forced rerun with only control messages does not start a provider", async (t) => {
  const f = await fixture(t);
  const { caseId } = await f.manager.receive(f.message("/session"));
  await f.force(caseId);
  assert.equal(f.requests.length, 0);
});

test("task lookup preserves timestamp order for late-arriving messages", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const control = f.caseStore.ingest({
    ...f.message("/session"), timestamp: now,
  }, undefined, { useActiveSession: true });
  const task = f.caseStore.ingest({
    ...f.message("late task"), timestamp: now - 1000,
  }, undefined, { useActiveSession: true });
  f.caseStore.markControlHandled(control.caseId, task.messageRow);
  await f.force(control.caseId);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].message.text, "late task");
});

test("pending owner control messages are not included in a task prompt", async (t) => {
  const f = await fixture(t);
  const task = f.caseStore.ingest(f.message("finish the report"), undefined, {
    useActiveSession: true,
  });
  f.caseStore.ingest(f.message("/session missing"), undefined, {
    useActiveSession: true,
  });
  await f.manager.run(task.caseId);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].message.text, "finish the report");
  assert.equal(f.requests[0].currentMessageCount, 1);
});

test("forced rerun does not resurrect a task from before clear", async (t) => {
  const f = await fixture(t);
  const { caseId } = await f.manager.receive(f.message("old task"));
  await f.manager.run(caseId);
  await f.manager.receive(f.message("/clear"));
  await f.manager.receive(f.message("/session"));
  await f.force(caseId);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.sessionStore.history(caseId), []);
});

test("model commands with a task continue using the rewritten task text", async (t) => {
  const f = await fixture(t);
  const { caseId } = await f.manager.receive(
    f.message("/model default finish the report"),
  );
  await f.force(caseId);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].message.text, "finish the report");
});

test("public command-like text remains ordinary conversation input", async (t) => {
  const f = await fixture(t, "public");
  const { caseId } = await f.manager.receive(f.message("/session project"));
  await f.force(caseId);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].message.text, "/session project");
});
