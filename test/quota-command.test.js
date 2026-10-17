import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";

async function fixture(t, { access = "owner", reply } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-quota-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  const config = loadConfig({ WEBOT_DATA_DIR: directory }, {
    identity: { selfId: "self" },
    pad: { sources: [{ id: "source", selfId: "self", allowSelf: true }] },
    policy: { allowSelf: true, groupTriggers: ["webot"] },
    caseManagement: { autoRun: true, autoSend: true, workerConcurrency: 1 },
  });
  const sent = [];
  const turns = [];
  let queries = 0;
  const transport = { async send(message, text) {
    sent.push({ message, text });
    return { ok: true };
  } };
  const manager = new CaseManager({
    config, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 10),
    requesterAccess: () => access,
    transports: { pad: transport, telegram: transport },
    quotaQuery: async () => {
      queries += 1;
      return { ok: true, enabled: [{ name: "synthetic-account", status: "active", quota: null }] };
    },
    provider: { async reply(request) {
      turns.push(request);
      await reply?.(request);
      return { text: "ordinary reply" };
    } },
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
    selfConversation: true, exactSelfChat: true, timestamp: Date.now(),
    messageId: `quota-${++sequence}`, text, ...extra,
  });
  return { manager, store, sent, turns, message, queries: () => queries };
}

for (const transport of ["pad", "telegram"]) {
  test(`owner quota is handled once without a worker on ${transport}`, async (t) => {
    const f = await fixture(t);
    const input = f.message("/quota", { transport });
    const result = await f.manager.receive(input);
    assert.equal(result.command, "quota");
    assert.equal(result.queued, false);
    assert.equal(f.queries(), 1);
    assert.equal(f.turns.length, 0);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /余量未知/);
    assert.equal(f.sent[0].message.transport, transport);
    assert.equal(f.store.detail(result.caseId).drafts.length, 1);
    const duplicate = await f.manager.receive(input);
    assert.equal(duplicate.reason, "duplicate");
    assert.equal(f.queries(), 1);
    assert.equal(f.sent.length, 1);
  });
}

test("public quota text never queries the private service", async (t) => {
  const f = await fixture(t, { access: "public" });
  const result = await f.manager.receive(f.message("/quota"));
  const running = f.manager.runPromises.get(result.caseId);
  if (running) await running;
  assert.equal(f.queries(), 0);
  assert.equal(f.turns.length, 1);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.sent[0].text, /synthetic-account/);
});

test("quota returns while a worker is busy and preserves queued task input", async (t) => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await fixture(t, { reply: () => gate.promise });
  const first = await f.manager.receive(f.message("original task"));
  const deadline = Date.now() + 2000;
  while (f.turns.length === 0) {
    if (Date.now() > deadline) throw new Error("worker did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await f.manager.receive(f.message("additional requirement"));
  const command = f.manager.receive(f.message("/authquota"));
  let timer;
  try {
    const result = await Promise.race([
      command,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("quota waited for worker")), 1000);
      }),
    ]);
    assert.equal(result.command, "quota");
    assert.equal(f.queries(), 1);
    assert.equal(f.turns.length, 1);
    assert.equal(f.store.workerSession(first.caseId).last_processed_message_id, 0);
    assert.deepEqual(f.store.pendingMessages(first.caseId).map((row) => row.text), [
      "original task", "additional requirement",
    ]);
  } finally {
    clearTimeout(timer);
    gate.resolve();
  }
});
