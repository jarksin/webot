import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseStore, caseIdFor } from "../src/case-store.js";
import { CaseManager } from "../src/case-manager.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";
import { markHydratedImage, modelImages } from "../src/inbound-images.js";

async function fixture(t, transport = "pad") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-session-context-"));
  const store = new CaseStore(path.join(directory, "webot.sqlite"));
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  let nextId = 0;
  const message = (extra = {}) => ({
    transport, sourceId: "source", chatId: "self",
    conversationId: "private:self", senderId: "self", selfId: "self",
    chatType: "private", direction: "incoming",
    selfConversation: true, exactSelfChat: true,
    messageId: `message-${++nextId}`, timestamp: Date.now(), text: "task",
    ...extra,
  });
  const base = message();
  const scope = caseIdFor(base);
  const image = {
    kind: "image", filename: "image.png",
    downloadContext: transport === "pad"
      ? { endpoint: "/api/v1/media/download-img-binary", msgId: 7 }
      : { type: "telegram", chatId: "self", messageId: 7 },
  };
  return { directory, store, message, scope, image };
}

for (const transport of ["pad", "telegram"]) {
  test(`${transport} automatic media follows its captured session, not the current selection`, async (t) => {
    const f = await fixture(t, transport);
    const mainImage = f.message({ attachments: [f.image] });
    f.store.ingestSyncedMessage(mainImage);
    const pad = f.store.createSession(f.scope, "pad");
    const padImage = f.message({ attachments: [f.image] });
    f.store.ingestSyncedMessage(padImage);
    const qw = f.store.createSession(f.scope, "qw");
    const qwImage = f.message({ attachments: [f.image] });
    f.store.ingestSyncedMessage(qwImage);
    // Repeated delivery after a switch must not change the original assignment.
    f.store.ingestSyncedMessage(padImage);
    const trigger = f.message({ timestamp: Date.now() + 1000 });
    const ids = (caseId) => f.store.mediaContextBefore(trigger, { caseId })
      .map((row) => row.message_id);
    assert.deepEqual(ids(pad.target_case_id), [padImage.messageId]);
    assert.deepEqual(ids(qw.target_case_id), [qwImage.messageId]);
    assert.deepEqual(ids(f.scope), [mainImage.messageId]);
    assert.deepEqual(f.store.mediaContextBefore(trigger)
      .map((row) => row.message_id), [qwImage.messageId]);
    f.store.activateSession(f.scope, "main");
    f.store.deleteSession(f.scope, "pad");
    f.store.deleteSession(f.scope, "qw");
    assert.deepEqual(ids(f.scope), [mainImage.messageId]);
  });

  test(`${transport} workers do not hydrate another session's images unless explicitly quoted`, async (t) => {
    const f = await fixture(t, transport);
    const requests = [];
    const config = loadConfig({ WEBOT_DATA_DIR: f.directory }, {
      identity: { selfId: "self" },
      caseManagement: { autoRun: false, autoSend: false },
      pad: { sources: [{ id: "source", selfId: "self", allowSelf: true }] },
      telegram: { sources: [{ id: "source", allowSelf: true }] },
    });
    const hydrate = async (message) => ({
      ...message,
      attachments: (message.attachments || []).map((item) =>
        markHydratedImage(item, { localPath: `/cache/${message.messageId}.png` })),
      ...(message.reference ? { reference: await hydrate(message.reference) } : {}),
    });
    const manager = new CaseManager({
      config, caseStore: f.store,
      sessionStore: new SessionStore(path.join(f.directory, "sessions"), 4),
      requesterAccess: () => "owner",
      hydratePadMedia: hydrate,
      transports: {
        telegram: {
          async downloadInboundAttachment(message) {
            return { localPath: `/cache/${message.messageId}.png` };
          },
        },
      },
      provider: {
        async reply(request) {
          requests.push(request);
          return { text: "done", model: "test-model" };
        },
      },
      logger: { warn() {}, error() {} },
    });
    const receive = async (message) => {
      f.store.ingestSyncedMessage(message);
      const result = await manager.receive(message);
      assert.equal(result.accepted, true);
      return result.caseId;
    };
    const pad = f.store.createSession(f.scope, "pad");
    const padImage = f.message({ attachments: [f.image], text: "[image]" });
    await manager.run(await receive(padImage));
    const qw = f.store.createSession(f.scope, "qw");
    await manager.run(await receive(f.message()));
    assert.equal(requests.at(-1).caseId, qw.target_case_id);
    assert.deepEqual(requests.at(-1).mediaContext, []);
    assert.deepEqual(modelImages(requests.at(-1).message), []);
    const qwImage = f.message({ attachments: [f.image] });
    await manager.run(await receive(qwImage));
    f.store.activateSession(f.scope, "pad");
    const queuedCaseId = await receive(f.message());
    f.store.activateSession(f.scope, "qw");
    await manager.run(queuedCaseId);
    const queued = requests.at(-1);
    assert.equal(queued.caseId, pad.target_case_id);
    assert.deepEqual(queued.mediaContext.map((row) => row.message_id), [padImage.messageId]);
    assert.deepEqual(modelImages(queued.message, queued.mediaContext)
      .map((item) => item.messageId), [padImage.messageId]);
    await manager.run(await receive(f.message({
      reference: { messageId: padImage.messageId, text: "[image]", attachments: [f.image] },
    })));
    const quoted = requests.at(-1);
    assert.equal(quoted.caseId, qw.target_case_id);
    assert.deepEqual(quoted.mediaContext.map((row) => row.message_id), [qwImage.messageId]);
    assert.ok(modelImages(quoted.message, quoted.mediaContext)
      .some((item) => item.messageId === padImage.messageId));
  });
}

test("legacy media uses persisted routing and does not guess unknown named-session ownership", async (t) => {
  const f = await fixture(t);
  const pad = f.store.createSession(f.scope, "pad");
  const captured = f.message({ attachments: [f.image] });
  f.store.ingestSyncedMessage(captured);
  f.store.ingest(captured, captured.text, { useActiveSession: true });
  const unknown = f.message({ attachments: [f.image] });
  f.store.ingestSyncedMessage(unknown);
  f.store.db.prepare(`
    UPDATE synced_messages SET metadata_json=json_remove(metadata_json, '$.sessionCaseId')
  `).run();
  const qw = f.store.createSession(f.scope, "qw");
  const delayed = f.message({ attachments: [f.image] });
  f.store.activateSession(f.scope, "pad");
  f.store.ingest(delayed, delayed.text, { useActiveSession: true });
  f.store.activateSession(f.scope, "qw");
  f.store.ingestSyncedMessage(delayed);
  const trigger = f.message({ timestamp: Date.now() + 1000 });
  assert.deepEqual(f.store.mediaContextBefore(trigger, { caseId: pad.target_case_id })
    .map((row) => row.message_id), [captured.messageId, delayed.messageId]);
  assert.deepEqual(f.store.mediaContextBefore(trigger, { caseId: qw.target_case_id }), []);
});

test("Pad files and untriggered group background remain session-scoped", async (t) => {
  const f = await fixture(t);
  const group = (extra = {}) => f.message({
    chatType: "group", chatId: "room", conversationId: "group:room", ...extra,
  });
  const scope = caseIdFor(group());
  const pad = f.store.createSession(scope, "pad");
  const padFile = group({ attachments: [{ kind: "file", filename: "pad.txt" }] });
  f.store.ingestSyncedMessage(padFile);
  f.store.ingestGroupContext(padFile);
  const qw = f.store.createSession(scope, "qw");
  const qwFile = group({ attachments: [{ kind: "file", filename: "qw.txt" }] });
  f.store.ingestSyncedMessage(qwFile);
  f.store.ingestGroupContext(qwFile);
  const trigger = group({ timestamp: Date.now() + 1000 });
  f.store.ingestGroupContext(trigger);
  const media = (caseId) => f.store.mediaContextBefore(trigger, { caseId });
  const background = (caseId) => f.store.groupContextBefore(trigger, { caseId, limit: 50 });
  assert.deepEqual(media(pad.target_case_id).map((row) => row.message_id), [padFile.messageId]);
  assert.deepEqual(media(qw.target_case_id).map((row) => row.message_id), [qwFile.messageId]);
  assert.deepEqual(background(pad.target_case_id).map((row) => row.message_id), [padFile.messageId]);
  assert.deepEqual(background(qw.target_case_id).map((row) => row.message_id), [qwFile.messageId]);
});
