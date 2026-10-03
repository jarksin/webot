import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";

async function fixture(t, transport = "telegram", autoSend = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-session-output-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  const sent = [];
  const requests = new Map();
  const runs = new Set();
  let messageId = 0;
  const config = loadConfig({}, {
    identity: { selfId: "test-self" },
    caseManagement: {
      autoRun: false,
      autoSend,
      ownerIntermediateItems: true,
    },
    pad: {
      sources: [{
        id: "test-source",
        selfId: "test-self",
        allowSelf: true,
      }],
    },
    telegram: {
      sources: [{
        id: "test-source",
        allowSelf: true,
      }],
    },
  });
  const manager = new CaseManager({
    config,
    caseStore,
    sessionStore,
    provider: {
      reply(request) {
        return new Promise((resolve) => {
          requests.set(request.caseId, { ...request, resolve });
        });
      },
    },
    requesterAccess: () => "owner",
    transports: {
      [transport]: {
        async send(target, text) {
          sent.push({ chatId: target.chatId, text });
          return { ok: true, dryRun: false };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    for (const request of requests.values()) request.resolve({ text: "cleanup" });
    await Promise.allSettled(runs);
    caseStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function ingest(
    chatId = "test-self",
    sourceId = "test-source",
    text = "task",
  ) {
    const received = await manager.receive({
      transport,
      sourceId,
      messageId: `message-${++messageId}`,
      timestamp: Date.now(),
      chatType: "private",
      chatId,
      conversationId: `private:${chatId}`,
      senderId: chatId,
      selfId: chatId,
      replyTarget: chatId,
      direction: "incoming",
      selfConversation: true,
      exactSelfChat: true,
      text,
    });
    assert.equal(received.accepted, true);
    return received.caseId;
  }
  async function start(caseId) {
    const promise = manager.run(caseId);
    runs.add(promise);
    for (let index = 0; !requests.has(caseId) && index < 100; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(requests.has(caseId));
    const request = requests.get(caseId);
    return {
      progress: (text) => request.onItem({ type: "agent_message", text }),
      async finish(text = "finished") {
        request.resolve(typeof text === "object" ? text : { text });
        await promise;
        runs.delete(promise);
        requests.delete(caseId);
      },
    };
  }
  return { caseStore, sessionStore, manager, sent, ingest, start };
}

for (const transport of ["telegram", "pad"]) {
  test(`${transport} labels overlapping sessions through the last completion`, async (t) => {
    const f = await fixture(t, transport);
    const scope = await f.ingest();
    const main = await f.start(scope);
    await main.progress("before overlap");
    const project = f.caseStore.createSession(scope, "project-a");
    const projectCaseId = await f.ingest();
    assert.equal(projectCaseId, project.target_case_id);
    const named = await f.start(projectCaseId);
    await main.progress("main progress");
    await named.progress("project progress");
    await named.finish("project finished");
    await main.progress("main still running");
    await main.finish("main finished");
    assert.deepEqual(f.sent.map((item) => item.text), [
      "before overlap",
      "[main] main progress",
      "[project-a] project progress",
      "[project-a] [done] project finished",
      "[main] main still running",
      "[main] [done] main finished",
    ]);
    assert.equal(f.caseStore.detail(projectCaseId).drafts[0].text, "project finished");
    assert.equal((await f.sessionStore.history(scope)).at(-1).content, "main finished");
    f.caseStore.activateSession(scope, "main");
    await f.ingest();
    const next = await f.start(scope);
    await next.progress("next progress");
    await next.finish("next finished");
    assert.deepEqual(f.sent.slice(-2).map((item) => item.text), [
      "[main] next progress",
      "[main] [done] next finished",
    ]);
  });
}

test("existing idle sessions label a single running session", async (t) => {
  const f = await fixture(t);
  const scope = await f.ingest();
  f.caseStore.createSession(scope, "project-a");
  const namedId = await f.ingest();
  const run = await f.start(namedId);
  await run.progress("progress");
  await run.finish();
  assert.deepEqual(f.sent.map((item) => item.text), [
    "[project-a] progress",
    "[project-a] [done] finished",
  ]);
});

test("running sessions in different chats do not share labels", async (t) => {
  const f = await fixture(t);
  const firstScope = await f.ingest();
  f.caseStore.createSession(firstScope, "project-a");
  const firstId = await f.ingest();
  const first = await f.start(firstId);
  const otherScope = await f.ingest("other-chat");
  const other = await f.start(otherScope);
  await first.progress("first progress");
  await other.progress("other progress");
  await first.finish("first finished");
  await other.finish("other finished");
  assert.deepEqual(f.sent.map((item) => item.text), [
    "[project-a] first progress",
    "other progress",
    "[project-a] [done] first finished",
    "[done] other finished",
  ]);
});

test("the same chat on independent source accounts does not share labels", async (t) => {
  const f = await fixture(t);
  f.manager.config.telegram.sources.push({
    ...f.manager.config.telegram.sources[0],
    id: "other-source",
  });
  const scope = await f.ingest();
  const main = await f.start(scope);
  const otherScope = await f.ingest("test-self", "other-source");
  const other = await f.start(otherScope);
  await main.progress("first progress");
  await other.progress("other progress");
  await main.finish();
  await other.finish();
  assert.deepEqual(f.sent.map((item) => item.text), [
    "first progress",
    "other progress",
    "[done] finished",
    "[done] finished",
  ]);
});

test("delayed draft sends retain their session labels after both runs finish", async (t) => {
  const f = await fixture(t, "telegram", false);
  const scope = await f.ingest();
  const main = await f.start(scope);
  f.caseStore.createSession(scope, "project-a");
  const namedId = await f.ingest();
  const named = await f.start(namedId);
  await named.finish("project finished");
  await main.finish("main finished");
  assert.equal(f.sent.length, 0);
  assert.equal(f.manager.running.size, 0);
  const projectDraft = f.caseStore.detail(namedId).drafts[0];
  const mainDraft = f.caseStore.detail(scope).drafts[0];
  assert.equal(projectDraft.output_session_name, "project-a");
  assert.equal(mainDraft.output_session_name, "main");
  await f.manager.sendDraft(namedId, projectDraft.id);
  await f.manager.sendDraft(scope, mainDraft.id);
  assert.deepEqual(f.sent.map((item) => item.text), [
    "[project-a] [done] project finished",
    "[main] [done] main finished",
  ]);
  await f.manager.sendDraft(namedId, projectDraft.id);
  assert.equal(f.sent.length, 2);
});

test("a failed final send retains its label for a later retry", async (t) => {
  const f = await fixture(t);
  const send = f.manager.transports.telegram.send;
  let rejected = false;
  f.manager.transports.telegram.send = async (target, text) => {
    if (!rejected) {
      rejected = true;
      throw new Error("send failed");
    }
    return send(target, text);
  };
  const scope = await f.ingest();
  const main = await f.start(scope);
  f.caseStore.createSession(scope, "project-a");
  const namedId = await f.ingest();
  const named = await f.start(namedId);
  await named.finish("project finished");
  await main.finish("main finished");
  const draft = f.caseStore.detail(namedId).drafts[0];
  assert.equal(draft.status, "draft");
  await f.manager.sendDraft(namedId, draft.id);
  assert.equal(f.sent.at(-1).text, "[project-a] [done] project finished");
});

test("oversized attachment fallback replies retain the originating session label", async (t) => {
  const f = await fixture(t);
  f.manager.transports.telegram.sendArtifact = async () => {
    const error = new Error("attachment exceeds 64 MiB");
    error.code = "WEBOT_ATTACHMENT_TOO_LARGE";
    throw error;
  };
  const scope = await f.ingest();
  const main = await f.start(scope);
  f.caseStore.createSession(scope, "project-a");
  const namedId = await f.ingest();
  const named = await f.start(namedId);
  await named.finish({
    text: "attached",
    artifacts: [{ kind: "file", path: "/tmp/large.zip" }],
  });
  await main.finish();
  assert.match(f.sent[0].text, /^\[project-a\] \[done\] /);
  assert.match(f.sent[0].text, /large\.zip/);
  assert.equal(f.sent[1].text, "[main] [done] finished");
});

test("session prefixes do not depend on intermediate output settings", async (t) => {
  const f = await fixture(t);
  f.manager.config.caseManagement.ownerIntermediateItems = false;
  const scope = await f.ingest();
  const main = await f.start(scope);
  f.caseStore.createSession(scope, "project-a");
  const namedId = await f.ingest();
  const named = await f.start(namedId);
  await main.progress("hidden");
  await named.finish();
  await main.finish();
  assert.deepEqual(f.sent.map((item) => item.text), [
    "[project-a] finished",
    "[main] finished",
  ]);
});

test("overlapping silent sessions remain silent", async (t) => {
  const f = await fixture(t);
  const scope = await f.ingest();
  const main = await f.start(scope);
  f.caseStore.createSession(scope, "project-a");
  const namedId = await f.ingest();
  const named = await f.start(namedId);
  await named.finish('{"reply_text":"","attachments":[]}');
  await main.finish();
  assert.deepEqual(f.sent.map((item) => item.text), ["[main] [done] finished"]);
  assert.equal(f.caseStore.detail(namedId).drafts.length, 0);
});

for (const transport of ["telegram", "pad"]) {
  test(`${transport} labels switches with their origin and previews the destination`, async (t) => {
    const f = await fixture(t, transport);
    const scope = await f.ingest();
    const main = await f.start(scope);
    await main.finish({ text: "main result", model: "main-model" });
    await f.ingest("test-self", "test-source", "/session new project-a");
    assert.match(f.sent.at(-1).text, /^\[main\] 已新建并切换 session「main」→「project-a」/);
    const namedId = await f.ingest();
    const named = await f.start(namedId);
    await named.finish({ text: "project result", model: "gpt-6-astra" });
    f.caseStore.setRuntimeSetting(`assistant_model:${namedId}`, "next-model");
    await f.ingest("test-self", "test-source", "/session main");
    assert.equal(f.sent.at(-1).text,
      "[project-a] 已切换 session「project-a」→「main」。\nuser: task\nmain-model: main result");
    await f.ingest("test-self", "test-source", "/session project-a");
    assert.equal(f.sent.at(-1).text,
      "[main] 已切换 session「main」→「project-a」。\nuser: task\ngpt-6-astra: project result");
    await f.ingest("test-self", "test-source", "/status");
    assert.match(f.sent.at(-1).text, /^\[project-a\] 当前 session/);
    const status = f.sent.at(-1).text;
    await f.ingest("test-self", "test-source", "/st");
    assert.equal(f.sent.at(-1).text, status);
    await f.ingest("test-self", "test-source", "/session main");
    await f.ingest("test-self", "test-source", "/session project-a");
    assert.equal(f.sent.at(-1).text,
      "[main] 已切换 session「main」→「project-a」。\nuser: task\ngpt-6-astra: project result");
    assert.equal((await f.sessionStore.history(namedId)).at(-1).content, "project result");
  });
}

test("single-session output stays unlabelled and deleted sessions do not count", async (t) => {
  const f = await fixture(t);
  const scope = await f.ingest();
  const main = await f.start(scope);
  await main.progress("single progress");
  await main.finish("single result");
  assert.deepEqual(f.sent.map((item) => item.text), [
    "single progress",
    "[done] single result",
  ]);
  f.caseStore.createSession(scope, "temporary");
  f.caseStore.activateSession(scope, "main");
  f.caseStore.deleteSession(scope, "temporary");
  await f.ingest();
  const next = await f.start(scope);
  await next.progress("next progress");
  await next.finish("next result");
  assert.deepEqual(f.sent.slice(-2).map((item) => item.text), [
    "next progress",
    "[done] next result",
  ]);
});

test("a draft created before a second session is labelled when sent later", async (t) => {
  const f = await fixture(t, "telegram", false);
  const scope = await f.ingest();
  const main = await f.start(scope);
  await main.finish("main result");
  const draft = f.caseStore.detail(scope).drafts[0];
  assert.equal(draft.output_session_name, "");
  f.caseStore.createSession(scope, "project-a");
  await f.manager.sendDraft(scope, draft.id);
  assert.equal(f.sent.at(-1).text, "[main] [done] main result");
});
