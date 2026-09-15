import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

test("serves health and verifies signed Hook callbacks", async () => {
  const config = loadConfig({
    WEBOT_HOST: "127.0.0.1",
    WEBOT_PORT: "0",
    WEBOT_CHANNELS: "hook",
    WEBOT_HOOK_CALLBACK_SECRET: "secret",
  });
  const received = [];
  const app = createServer({
    config,
    runtime: {
      async receive(message) {
        received.push(message);
        return { accepted: true };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const address = await app.start();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`).then((response) =>
    response.json(),
  );
  assert.equal(health.ok, true);
  assert.deepEqual(health.channels, ["hook"]);

  const body = JSON.stringify({
    post_type: "message",
    message_type: "private",
    self_id: "wxid_bot",
    user_id: "wxid_peer",
    message_id: 99,
    message: "hello",
  });
  const signature = crypto
    .createHmac("sha256", "secret")
    .update(body)
    .digest("hex");
  const response = await fetch(`${base}/webhooks/hook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webot-Signature": `sha256=${signature}`,
    },
    body,
  });
  assert.equal(response.status, 202);
  assert.equal(received.length, 1);

  const removedPadCallback = await fetch(`${base}/webhooks/pad`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(removedPadCallback.status, 404);

  await app.stop();
});

test("serves local AGENTS and knowledge editor APIs", async () => {
  let agent = {
    path: "/tmp/workspace/AGENTS.md",
    content: "# Webot\n",
    hash: "agent-hash",
  };
  let document = {
    file: "owner/profile.md",
    content: "# Profile\n",
    hash: "kb-hash",
  };
  const application = {
    config: loadConfig({
      WEBOT_HOST: "127.0.0.1",
      WEBOT_PORT: "0",
    }),
    status() {
      return {
        ok: true,
        runtime: { sourceRevision: "1234567890abcdef" },
      };
    },
    settings() {
      return {};
    },
    listCases() {
      return {
        cases: [],
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      };
    },
    directory(options) {
      return [{
        source_id: options.sourceId || "small",
        entity_type: options.entityType || "group",
        entity_id: "123@chatroom",
        display_name: "项目群",
      }];
    },
    syncDirectory(sourceId) {
      return {
        imported: 1,
        sources: [{ sourceId: sourceId || "small", imported: 1 }],
      };
    },
    caseManager: { status() { return {}; } },
    startConnectors() {},
    stopConnectors() {},
    agentDocument() {
      return agent;
    },
    saveAgentDocument(content) {
      agent = { ...agent, content, hash: "agent-updated" };
      return agent;
    },
    knowledgeDocuments() {
      return [document];
    },
    knowledgeDocument() {
      return document;
    },
    saveKnowledgeDocument(file, content) {
      document = { ...document, file, content, hash: "kb-updated" };
      return document;
    },
    deleteKnowledgeDocument(file) {
      return { file };
    },
  };
  const app = createServer({
    application,
    logger: { info() {}, warn() {}, error() {} },
  });
  const address = await app.start();
  const base = `http://127.0.0.1:${address.port}`;

  const adminHtml = await fetch(base).then((response) => response.text());
  assert.match(
    adminHtml,
    /name="webot-runtime-revision" content="1234567890abcdef"/,
  );
  assert.doesNotMatch(adminHtml, /__WEBOT_RUNTIME_REVISION__/);
  assert.equal(
    (await fetch(`${base}/api/admin/agent`).then((response) => response.json()))
      .document.hash,
    "agent-hash",
  );
  assert.equal(
    (
      await fetch(`${base}/api/admin/agent`, {
        method: "PUT",
        body: JSON.stringify({ content: "# Updated\n" }),
      }).then((response) => response.json())
    ).document.hash,
    "agent-updated",
  );
  assert.equal(
    (
      await fetch(`${base}/api/admin/kb/documents`).then((response) =>
        response.json(),
      )
    ).documents.length,
    1,
  );
  assert.equal(
    (
      await fetch(`${base}/api/admin/kb/document`, {
        method: "PUT",
        body: JSON.stringify({
          file: "owner/profile.md",
          content: "# Updated profile\n",
        }),
      }).then((response) => response.json())
    ).document.hash,
    "kb-updated",
  );
  assert.equal(
    (
      await fetch(`${base}/api/admin/kb/document`, {
        method: "DELETE",
        body: JSON.stringify({ file: "owner/profile.md" }),
      }).then((response) => response.json())
    ).deleted.file,
    "owner/profile.md",
  );
  const directory = await fetch(
    `${base}/api/admin/directory?sourceId=small&type=group&query=项目`,
  ).then((response) => response.json());
  assert.equal(directory.entries[0].entity_id, "123@chatroom");
  const synced = await fetch(`${base}/api/admin/directory/sync`, {
    method: "POST",
    body: JSON.stringify({ sourceId: "small" }),
  }).then((response) => response.json());
  assert.equal(synced.imported, 1);

  await app.stop();
});

test("returns an unhealthy status when message ingress is degraded", async () => {
  const application = {
    config: loadConfig({
      WEBOT_HOST: "127.0.0.1",
      WEBOT_PORT: "0",
    }),
    status() {
      return {
        ok: false,
        ingress: {
          ready: false,
          degradedSourceIds: ["small-opt"],
        },
      };
    },
    startConnectors() {},
    stopConnectors() {},
  };
  const app = createServer({
    application,
    logger: { info() {}, warn() {}, error() {} },
  });
  const address = await app.start();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const health = await response.json();

  assert.equal(response.status, 503);
  assert.equal(health.ok, false);
  assert.deepEqual(health.ingress.degradedSourceIds, ["small-opt"]);
  await app.stop();
});
