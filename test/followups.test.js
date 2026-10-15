import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";
import { markHydratedImage, modelImages } from "../src/inbound-images.js";

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for follow-up");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-followups-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const config = loadConfig({ WEBOT_DATA_DIR: directory }, {
    identity: { selfId: "self" },
    assistant: { codexBin: process.execPath, codexHome: directory },
    pad: { sources: [{ id: "source", selfId: "self", allowSelf: true }] },
    caseManagement: {
      autoRun: options.autoRun !== false, autoSend: true, workerConcurrency: 1,
    },
  });
  const turns = [];
  const sent = [];
  const manager = new CaseManager({
    config, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 10),
    requesterAccess: () => "owner",
    transports: { pad: { async send(message, text) {
      sent.push({ message, text });
      return { ok: true };
    } } },
    provider: {
      async reply(request) {
        turns.push(request);
        await options.reply?.(request, turns.length);
        return { text: "done", sessionId: "thread" };
      },
      ...options.provider,
    },
    hydratePadMedia: options.hydrate,
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    manager.stopAll();
    await Promise.allSettled([...manager.runPromises.values()]);
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const message = (text, extra = {}) => ({
    transport: "pad", sourceId: "source", chatId: "self",
    conversationId: "private:self", senderId: "self", selfId: "self",
    chatType: "private", direction: "incoming",
    selfConversation: true, exactSelfChat: true,
    messageId: `message-${++sequence}`, timestamp: Date.now(), text, ...extra,
  });
  return { store, manager, turns, sent, message };
}

test("control replies preserve pending task cursors and restart discovery", async (t) => {
  const f = await fixture(t, { autoRun: false });
  const { caseId } = await f.manager.receive(f.message("original task"));
  await f.manager.receive(f.message("additional requirement"));
  for (const command of ["/status", "/effort high", "/model default", "/session"]) {
    await f.manager.receive(f.message(command));
    assert.equal(f.store.workerSession(caseId).last_processed_message_id, 0);
    assert.equal(f.store.caseRow(caseId).status, "new");
    assert.ok(f.store.pendingCaseIds().includes(caseId));
  }
  assert.deepEqual(f.store.pendingMessages(caseId).map((row) => row.text),
    ["original task", "additional requirement"]);
  const reopened = new CaseStore(f.store.file);
  try {
    assert.ok(reopened.pendingCaseIds().includes(caseId));
    assert.deepEqual(reopened.pendingMessages(caseId).map((row) => row.text),
      ["original task", "additional requirement"]);
  } finally {
    reopened.close();
  }
  await f.manager.run(caseId);
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].message.text, "original task\nadditional requirement");
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 6);
  assert.equal(f.store.caseRow(caseId).status, "replied");
  assert.equal(f.store.pendingCaseIds().length, 0);
});

test("queued follow-ups survive a session switch without moving to the new session", async (t) => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await fixture(t, {
    reply: async (_request, count) => { if (count === 1) await gate.promise; },
    provider: { async steer() { return { accepted: false, error: "turn ended" }; } },
  });
  const { caseId } = await f.manager.receive(f.message("original task"));
  await waitFor(() => f.turns.length === 1);
  await f.manager.receive(f.message("queued requirement"));
  await f.manager.receive(f.message("/session new other"));
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 0);
  gate.resolve();
  await waitFor(() => f.turns.length === 2 && f.manager.status().active === 0);
  assert.equal(f.turns[1].message.text, "queued requirement");
  assert.equal(f.turns[1].caseId, caseId);
  assert.notEqual(f.store.activeSession(caseId).target_case_id, caseId);
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 3);
  assert.equal(f.store.pendingMessages(caseId, 3).length, 0);
});

test("a failed later turn remains failed without marking its input processed", async (t) => {
  const f = await fixture(t, { autoRun: false });
  const { caseId } = await f.manager.receive(f.message("completed task"));
  await f.manager.run(caseId);
  await f.manager.receive(f.message("failed task"));
  f.store.startRun(caseId, 2);
  f.store.finishRun(caseId, "failed", "provider failure");
  assert.equal(f.store.caseRow(caseId).status, "failed");
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 1);
  assert.deepEqual(f.store.pendingMessages(caseId, 1).map((row) => row.text), ["failed task"]);
});

for (const command of ["/stop", "/clear"]) {
  test(`${command} explicitly discards pending work without replaying it`, async (t) => {
    const f = await fixture(t, { autoRun: false });
    const { caseId } = await f.manager.receive(f.message("cancelled task"));
    await f.manager.receive(f.message("cancelled follow-up"));
    await f.manager.receive(f.message(command));
    assert.equal(f.store.workerSession(caseId).last_processed_message_id, 3);
    assert.equal(f.store.pendingMessages(caseId, 3).length, 0);
    await f.manager.run(caseId);
    assert.equal(f.turns.length, 0);
  });
}

test("native media steering hydrates quoted images and keeps following text in the same turn", async (t) => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const steered = [];
  const hydrated = [];
  const f = await fixture(t, {
    reply: async () => gate.promise,
    hydrate: async (message) => {
      hydrated.push(message.messageId);
      if (!message.reference) return message;
      return { ...message, reference: {
        ...message.reference,
        attachments: message.reference.attachments.map((attachment) =>
          markHydratedImage(attachment, { localPath: "/cache/quoted.png" })),
      } };
    },
    provider: {
      supportsMediaSteering: true,
      async steer(request) { steered.push(request); return { accepted: true }; },
    },
  });
  const { caseId } = await f.manager.receive(f.message("original task"));
  await waitFor(() => f.turns.length === 1);
  assert.equal((await f.manager.receive(f.message("look at this", {
    reference: { messageId: "photo", attachments: [{ kind: "image" }] },
  }))).steered, true);
  assert.equal((await f.manager.receive(f.message("another requirement"))).steered, true);
  assert.deepEqual(modelImages(steered[0].message), [
    { path: "/cache/quoted.png", messageId: "photo" },
  ]);
  assert.deepEqual(hydrated, ["message-1", "message-2", "message-3"]);
  gate.resolve();
  await waitFor(() => f.manager.status().active === 0);
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 3);
});

test("a turn finishing during media hydration queues the supplement exactly once", async (t) => {
  const task = Promise.withResolvers();
  const media = Promise.withResolvers();
  t.after(() => { task.resolve(); media.resolve(); });
  let hydrating = false;
  const f = await fixture(t, {
    reply: async (_request, count) => { if (count === 1) await task.promise; },
    hydrate: async (message) => {
      if (message.attachments?.length) { hydrating = true; await media.promise; }
      return message;
    },
    provider: {
      supportsMediaSteering: true,
      async steer() { return { accepted: false, reason: "turn-ended" }; },
    },
  });
  const { caseId } = await f.manager.receive(f.message("original task"));
  await waitFor(() => f.turns.length === 1);
  const received = f.manager.receive(f.message("supplement", {
    attachments: [{ kind: "image", error: "image_download_failed" }],
  }));
  await waitFor(() => hydrating);
  task.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 0);
  media.resolve();
  await received;
  await waitFor(() => f.turns.length === 2 && f.manager.status().active === 0);
  assert.equal(f.turns[1].message.text, "supplement");
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 2);
});

test("completion waits for an accepted in-flight steer before advancing its cursor", async (t) => {
  const task = Promise.withResolvers();
  const steer = Promise.withResolvers();
  t.after(() => { task.resolve(); steer.resolve({ accepted: true }); });
  let steering = false;
  const f = await fixture(t, {
    reply: async () => task.promise,
    provider: { async steer() { steering = true; return steer.promise; } },
  });
  const { caseId } = await f.manager.receive(f.message("original task"));
  await waitFor(() => f.turns.length === 1);
  const received = f.manager.receive(f.message("supplement"));
  await waitFor(() => steering);
  task.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 0);
  steer.resolve({ accepted: true });
  assert.equal((await received).steered, true);
  await waitFor(() => f.manager.status().active === 0);
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.workerSession(caseId).last_processed_message_id, 2);
});

test("rejected earlier media prevents later text from bypassing it", async (t) => {
  const task = Promise.withResolvers();
  const steer = Promise.withResolvers();
  t.after(() => { task.resolve(); steer.resolve({ accepted: false }); });
  let steers = 0;
  const f = await fixture(t, {
    reply: async (_request, count) => { if (count === 1) await task.promise; },
    provider: {
      supportsMediaSteering: true,
      async steer() { steers++; return steer.promise; },
    },
  });
  await f.manager.receive(f.message("original task"));
  await waitFor(() => f.turns.length === 1);
  const earlier = f.manager.receive(f.message("photo", { attachments: [{ kind: "image" }] }));
  await waitFor(() => steers === 1);
  const later = f.manager.receive(f.message("explain the photo"));
  steer.resolve({ accepted: false });
  await Promise.all([earlier, later]);
  assert.equal(steers, 1);
  task.resolve();
  await waitFor(() => f.turns.length === 2 && f.manager.status().active === 0);
  assert.equal(f.turns[1].message.text, "photo\nexplain the photo");
});
