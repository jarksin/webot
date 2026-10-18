import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { SettingsStore, serializeConfig } from "../src/settings-store.js";
import { WebotApplication } from "../src/application.js";
import { createServer } from "../src/server.js";
import { requesterAccess, validSignature } from "../src/security.js";
import { acceptedMessage } from "../src/runtime.js";
import { caseIdFor, CaseStore } from "../src/case-store.js";
import { normalizeXianyuEvent } from "../src/xianyu-sources.js";
import { XianyuTransport } from "../src/transports/xianyu.js";
import { createCodexProvider } from "../src/codex-provider.js";

const secret = "fictional-xianyu-test-secret";
const env = { XIANYU_TEST_SECRET: secret };
const sourceSettings = {
  id: "shop",
  enabled: true,
  bridgeUrl: "http://127.0.0.1:12345",
  accountId: "seller",
  secretEnv: "XIANYU_TEST_SECRET",
};
const logger = { info() {}, warn() {}, error() {} };

function configFor(overrides = {}) {
  return loadConfig(env, {
    channels: ["xianyu"],
    xianyu: { sources: [{ ...sourceSettings, ...overrides }] },
  });
}

function event(overrides = {}) {
  return {
    messageId: "m1", chatId: "chat1", senderId: "buyer",
    accountId: "seller", text: "hello", timestamp: Date.now(),
    direction: "incoming", type: "text", ...overrides,
  };
}

function sign(raw, key = secret) {
  return `sha256=${crypto.createHmac("sha256", key).update(raw).digest("hex")}`;
}

async function fixture(t, { outboundMode = "live", receipt, autoRun = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-xianyu-"));
  const calls = [];
  const bridge = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    calls.push({
      url: request.url, method: request.method,
      signatureValid: validSignature(raw, request.headers["x-webot-signature"], secret),
      body: JSON.parse(raw),
    });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(receipt || { ok: true, status: "sent", messageId: "sent1" }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.save({
    channels: ["xianyu"], outboundMode,
    assistant: { mode: "echo" },
    policy: { ownerSenderIds: ["buyer", "xianyu:shop:seller:user:buyer"] },
    caseManagement: { autoRun, autoSend: true },
    xianyu: { sources: [{
      ...sourceSettings, bridgeUrl: `http://127.0.0.1:${bridge.address().port}`,
    }] },
  });
  const app = new WebotApplication({
    env: { ...env, WEBOT_DATA_DIR: directory, WEBOT_PORT: "0" },
    settingsStore, logger,
  });
  await app.initialize();
  const server = createServer({ application: app, logger });
  const address = await server.start();
  t.after(async () => {
    await Promise.all([...app.caseManager.runPromises.values()]);
    await server.stop();
    app.caseStore.close();
    await new Promise((resolve) => bridge.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${address.port}`;
  return {
    app, calls, directory, settingsStore, url,
    async post(value = event(), { signature, sourceId = "shop", raw } = {}) {
      const body = raw ?? JSON.stringify(value);
      const response = await fetch(`${url}/webhooks/xianyu/${sourceId}`, {
        method: "POST", headers: {
          "Content-Type": "application/json",
          "x-webot-signature": signature ?? sign(body),
        },
        body,
      });
      return { status: response.status, body: await response.json() };
    },
    async drain() {
      await Promise.all([...app.caseManager.runPromises.values()]);
    },
  };
}

test("Xianyu is opt-in, requires protected secrets and fixed bridge origins", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.channels.has("xianyu"), false);
  assert.deepEqual(defaults.xianyu.sources, []);
  assert.equal(configFor({ enabled: undefined }).xianyu.sources[0].enabled, false);
  assert.throws(() => configFor({ secret: secret }), /secretEnv or secretFile/);
  assert.throws(() => loadConfig({}, {
    xianyu: { sources: [sourceSettings] },
  }), /nonempty secret/);
  for (const bridgeUrl of [
    "http://bridge.invalid", "https://user:pass@bridge.invalid",
    "https://bridge.invalid/?token=secret", "https://bridge.invalid/#fragment",
    "https://bridge.invalid/callback", "file:///tmp/bridge",
  ]) {
    assert.throws(() => configFor({ bridgeUrl }), /bridge URL/);
  }
  assert.throws(() => loadConfig(env, {
    xianyu: { sources: [sourceSettings, { ...sourceSettings, id: "SHOP" }] },
  }), /duplicate/);
});

test("Xianyu file secrets stay protected and serialized settings contain references only", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-xianyu-config-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "bridge.key");
  await fs.writeFile(secretFile, secret, { mode: 0o600 });
  const config = configFor({ secretEnv: "", secretFile });
  assert.equal(config.xianyu.sources[0].secret, secret);
  assert.equal(config.xianyu.sources[0].credentialSource, "file");
  const serialized = serializeConfig(config);
  assert.equal(JSON.stringify(serialized).includes(secret), false);
  const store = new SettingsStore(path.join(directory, "settings.json"));
  await store.save(serialized);
  await store.save({ outboundMode: "live" });
  assert.equal(loadConfig({}, store.current()).xianyu.sources[0].secret, secret);
  assert.equal((await fs.readFile(store.file, "utf8")).includes(secret), false);
  const redacted = store.publicSettings({
    xianyu: { sources: config.xianyu.sources },
  }, { preferFallback: true });
  assert.equal(redacted.xianyu.sources[0].secret, "");
  assert.equal(redacted.xianyu.sources[0].secretConfigured, true);
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  await assert.rejects(store.save({
    xianyu: { sources: [{ ...sourceSettings, secret }] },
  }), /secretEnv or secretFile/);
  await fs.chmod(secretFile, 0o644);
  assert.throws(() => configFor({ secretEnv: "", secretFile }), /private regular file/);
});

test("Xianyu normalization isolates source/account/chat and never grants owner", () => {
  const config = configFor();
  const source = config.xianyu.sources[0];
  const message = normalizeXianyuEvent(event(), source);
  assert.equal(requesterAccess(message, new Set([message.senderId]), config), "public");
  assert.equal(requesterAccess({
    transport: "xianyu", senderId: "buyer", exactSelfChat: true,
  }, new Set(["buyer"]), config), "public");
  assert.equal(acceptedMessage(message, config).accepted, true);
  for (const change of [
    { direction: "outgoing" }, { selfConversation: true },
    { sourceId: "unknown" }, { senderId: "buyer" },
    { attachments: [{ kind: "file", path: "/fixture/file" }] },
    { xianyu: { ...message.xianyu, accountId: "other" } },
  ]) {
    assert.equal(acceptedMessage({ ...message, ...change }, config).accepted, false);
  }
  const isolated = [
    message,
    normalizeXianyuEvent(event({ chatId: "chat2" }), source),
    normalizeXianyuEvent(event({ accountId: "seller2" }), { ...source, accountId: "seller2" }),
    normalizeXianyuEvent(event(), { ...source, id: "shop2" }),
  ];
  assert.equal(new Set(isolated.map(caseIdFor)).size, 4);
  assert.equal(new Set(isolated.map((item) => item.messageId)).size, 4);
});

test("signed Xianyu HTTP ingress runs CaseManager worker, draft and real bridge receipt once", async (t) => {
  const f = await fixture(t);
  const incoming = event({ text: "/stop" });
  const response = await f.post(incoming);
  assert.equal(response.status, 202);
  assert.equal(response.body.results[0].accepted, true);
  await f.drain();
  const message = normalizeXianyuEvent(incoming, f.app.config.xianyu.sources[0]);
  const detail = f.app.caseStore.detail(caseIdFor(message));
  assert.equal(detail.workerSession.run_count, 1);
  assert.equal(detail.drafts.length, 1);
  assert.equal(detail.drafts[0].status, "sent");
  assert.equal(detail.drafts[0].outbound.text.messageId, "sent1");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signatureValid, true);
  assert.equal(f.calls[0].url, "/v1/messages/send");
  assert.equal(f.calls[0].method, "POST");
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), [
    "accountId", "chatId", "inReplyTo", "requestId", "sourceId", "text",
  ]);
  assert.equal(f.calls[0].body.accountId, "seller");
  assert.equal(f.calls[0].body.sourceId, "shop");
  assert.equal(f.calls[0].body.chatId, "chat1");
  assert.equal(f.calls[0].body.inReplyTo, "m1");
  assert.match(f.calls[0].body.text, /\/stop/);
  assert.match(f.calls[0].body.requestId, /^xianyu-[a-f0-9]{64}$/);
  assert.equal((await f.post(incoming)).body.results[0].reason, "duplicate");
  assert.equal(f.calls.length, 1);
  const reopened = new CaseStore(path.join(f.directory, "webot.sqlite"), {
    recoverInterruptedRuns: false,
  });
  try {
    assert.equal(reopened.ingest(message).inserted, false);
  } finally {
    reopened.close();
  }
  const status = f.app.status();
  assert.equal(status.ok, true);
  assert.equal(status.xianyuSources[0].inboundMessages, 1);
  assert.equal(status.xianyuSources[0].loginState, "unverified");
  assert.equal(status.xianyuSources[0].connected, null);
  assert.ok(status.xianyuSources[0].lastSentAt);
  assert.equal(status.ingress.connectedSources, 0);
  assert.equal(JSON.stringify(status).includes(secret), false);
});

test("Xianyu ingress rejects forged, malformed, wrong-account, self, system and replay-age events before persistence", async (t) => {
  const f = await fixture(t);
  for (const signature of ["", sign("different body"), sign(JSON.stringify(event()), "wrong-key")]) {
    assert.equal((await f.post(event(), { signature })).status, 401);
  }
  assert.equal((await f.post(event(), { sourceId: "missing" })).status, 404);
  assert.equal((await f.post(null, { raw: "{invalid" })).status, 400);
  for (const patch of [
    { accountId: "other" }, { direction: "outgoing" }, { direction: "system" },
    { senderId: "seller" }, { senderId: "system" }, { type: "system" },
    { type: "image" }, { timestamp: Date.now() - 301_000 },
    { timestamp: Date.now() + 31_000 }, { timestamp: "1760000000000" },
    { timestamp: Math.floor(Date.now() / 1000) }, { messageId: 42 },
    { text: "" }, { text: "x".repeat(65537) },
    { text: "x".repeat(8001) }, { messageId: "m".repeat(161) },
    { owner: true }, { callbackUrl: "https://untrusted.invalid" },
    { transport: "pad" }, { attachments: [] },
  ]) {
    const result = await f.post(event(patch));
    assert.equal(result.status, 400, JSON.stringify(patch).slice(0, 100));
  }
  assert.equal(f.app.caseStore.casePage().total, 0);
  assert.equal(f.calls.length, 0);
  f.app.config.xianyu.sources[0].secret = "";
  assert.equal((await f.post()).status, 401);
  f.app.config.xianyu.sources[0].secret = secret;
  f.app.config.xianyu.sources[0].enabled = false;
  assert.equal((await f.post()).status, 503);
  f.app.config.xianyu.sources[0].enabled = true;
  f.app.config.channels.delete("xianyu");
  assert.equal((await f.post()).status, 503);
});

test("Xianyu dry-run creates a draft but never calls the bridge or marks sent", async (t) => {
  const f = await fixture(t, { outboundMode: "dry-run" });
  const incoming = event();
  assert.equal((await f.post(incoming)).body.results[0].accepted, true);
  await f.drain();
  const caseId = caseIdFor(normalizeXianyuEvent(incoming, f.app.config.xianyu.sources[0]));
  const detail = f.app.caseStore.detail(caseId);
  assert.equal(detail.workerSession.run_count, 1);
  assert.equal(detail.drafts.length, 1);
  assert.notEqual(detail.drafts[0].status, "sent");
  assert.equal(detail.drafts[0].outbound, null);
  assert.equal(f.calls.length, 0);
  const retry = await f.app.caseManager.sendDraft(caseId, detail.drafts[0].id);
  assert.equal(retry.dryRun, true);
  assert.equal(f.calls.length, 0);
});

test("queued bridge receipts preserve retryable drafts; requestId is stable across retries", async (t) => {
  const f = await fixture(t, {
    receipt: { ok: true, status: "queued", messageId: "queue1", secret },
  });
  const incoming = event();
  await f.post(incoming);
  await f.drain();
  const caseId = caseIdFor(normalizeXianyuEvent(incoming, f.app.config.xianyu.sources[0]));
  const draft = f.app.caseStore.detail(caseId).drafts[0];
  assert.notEqual(draft.status, "sent");
  assert.match(draft.error, /did not confirm sent/);
  assert.equal(JSON.stringify(f.app.caseStore.detail(caseId)).includes(secret), false);
  await assert.rejects(f.app.caseManager.sendDraft(caseId, draft.id), /did not confirm sent/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.requestId, f.calls[1].body.requestId);
  assert.equal(f.app.status().xianyuSources[0].lastSentAt, null);
});

test("Xianyu transport fails closed on missing receipt, account mismatch, redirects and bridge errors", async () => {
  const config = configFor();
  const message = normalizeXianyuEvent(event(), config.xianyu.sources[0]);
  let calls = 0;
  const transport = new XianyuTransport(config.xianyu, "live", async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    throw new Error(`private upstream error ${secret}`);
  });
  await assert.rejects(transport.send({
    ...message, xianyu: { ...message.xianyu, accountId: "other" },
  }, "reply"), /not bound/);
  assert.equal(calls, 0);
  await assert.rejects(transport.send({
    ...message, xianyu: { ...message.xianyu, chatId: "other-chat" },
  }, "reply"), /target is invalid/);
  await assert.rejects(transport.send({
    ...message, timestamp: Date.now() + 31_000,
  }, "reply"), /target is invalid/);
  assert.equal(calls, 0);
  await assert.rejects(transport.send(message, "reply"), {
    message: "Xianyu bridge delivery failed",
  });
  for (const receipt of [
    { ok: true }, { ok: true, status: "sent" },
    { ok: false, status: "sent", messageId: "m2" },
    { ok: true, status: "sent", messageId: 42 },
  ]) {
    transport.fetch = async () => Response.json(receipt);
    await assert.rejects(transport.send(message, "reply"), /did not confirm sent/);
  }
  const ids = [];
  transport.fetch = async (_url, options) => {
    ids.push(JSON.parse(options.body).requestId);
    return Response.json({ ok: true, status: "sent", messageId: "m2", secret });
  };
  const receipt = await transport.send(message, "reply");
  assert.equal(JSON.stringify(receipt).includes(secret), false);
  await transport.send(message, "reply");
  await transport.send(message, "different reply");
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.equal(typeof transport.sendArtifact, "undefined");
});

test("Xianyu settings updates preserve protected references and update transport mode", async (t) => {
  const f = await fixture(t, { autoRun: false });
  const result = await f.app.updateSettings({ outboundMode: "dry-run" });
  assert.equal(result.apply.mode, "dynamic");
  assert.equal(f.app.transports.xianyu.outboundMode, "dry-run");
  assert.equal(f.app.config.xianyu.sources[0].secret, secret);
  assert.equal(JSON.stringify(f.app.settings()).includes(secret), false);
  assert.equal((await fs.readFile(f.settingsStore.file, "utf8")).includes(secret), false);
  await assert.rejects(f.app.updateSettings({
    xianyu: { sources: [{ ...sourceSettings, secret }] },
  }), /secretEnv or secretFile/);
  assert.equal(f.app.config.xianyu.sources[0].secret, secret);
});

test("Xianyu messages with the same native ID in different chats remain isolated", async (t) => {
  const f = await fixture(t);
  const first = event({ chatId: "chat:a", messageId: "raw:m", text: "first chat" });
  const second = event({ chatId: "chat:b", messageId: "raw:m", text: "second chat" });
  await Promise.all([f.post(first), f.post(second)]);
  await f.drain();
  assert.equal(f.app.caseStore.casePage().total, 2);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(new Set(f.calls.map((call) => call.body.chatId)), new Set(["chat:a", "chat:b"]));
  assert.ok(f.calls.every((call) => call.body.inReplyTo === "raw:m"));
  const source = f.app.config.xianyu.sources[0];
  const firstId = caseIdFor(normalizeXianyuEvent(first, source));
  const secondId = caseIdFor(normalizeXianyuEvent(second, source));
  const firstHistory = await f.app.caseManager.sessionStore.history(firstId);
  const secondHistory = await f.app.caseManager.sessionStore.history(secondId);
  assert.equal(JSON.stringify(firstHistory).includes("second chat"), false);
  assert.equal(JSON.stringify(secondHistory).includes("first chat"), false);
});

test("Xianyu worker prompt identifies the channel and public text-only customer scope", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-xianyu-prompt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "codex");
  await fs.writeFile(binary, "", { mode: 0o700 });
  const config = configFor();
  const message = normalizeXianyuEvent(event(), config.xianyu.sources[0]);
  const provider = createCodexProvider({ codexBin: binary, codexHome: directory }, {
    requesterAccess: (value) => requesterAccess(value, new Set([value.senderId]), config),
    runCodex: async (_config, request) => {
      assert.match(request.prompt, /this Xianyu case/);
      assert.match(request.prompt, /Access level: public/);
      assert.match(request.prompt, /Only text replies are supported/);
      assert.equal(request.prompt.includes("this WeChat case"), false);
      return { text: "reply", sessionId: "fictional-session" };
    },
  });
  const result = await provider.reply({ caseId: caseIdFor(message), message, history: [] });
  assert.equal(result.text, "reply");
});

test("Xianyu health distinguishes disabled, missing source and webhook readiness", async (t) => {
  const f = await fixture(t, { autoRun: false });
  assert.equal(f.app.status().xianyuSources[0].ready, true);
  f.app.config.channels.delete("xianyu");
  assert.equal(f.app.status().xianyuSources[0].ready, false);
  assert.equal(f.app.status().ingress.configuredSources, 0);
  f.app.config.channels.add("xianyu");
  f.app.config.xianyu.sources[0].enabled = false;
  assert.equal(f.app.status().ok, false);
  f.app.config.xianyu.sources = [];
  assert.equal(f.app.status().ok, false);
});

test("Xianyu admission limits match the bridge in UTF-16 units and ASCII ID lengths", async () => {
  const config = configFor({ id: "s".repeat(160), accountId: "a".repeat(160) });
  const source = config.xianyu.sources[0];
  const incoming = event({
    accountId: source.accountId, messageId: "m".repeat(160),
    senderId: "u".repeat(160), chatId: "c".repeat(160),
    text: "\u{1f600}".repeat(4000),
  });
  const message = normalizeXianyuEvent(incoming, source);
  assert.equal(message.text.length, 8000);
  assert.throws(() => normalizeXianyuEvent({
    ...incoming, text: `${incoming.text}x`,
  }, source), /invalid or expired/);
  for (const field of ["messageId", "senderId", "chatId"]) {
    assert.throws(() => normalizeXianyuEvent({
      ...incoming, [field]: "x".repeat(161),
    }, source), /invalid or expired/);
  }
  assert.throws(() => configFor({ id: "s".repeat(161) }), /source id/);
  assert.throws(() => configFor({ accountId: "a".repeat(161) }), /account id/);
  let calls = 0;
  const transport = new XianyuTransport(config.xianyu, "live", async () => {
    calls++;
    return Response.json({ ok: true, status: "sent", messageId: "m".repeat(160) });
  });
  assert.equal((await transport.send(message, "\u{1f600}".repeat(2000))).status, "sent");
  await assert.rejects(transport.send(message, `${"\u{1f600}".repeat(2000)}x`), /reply text/);
  assert.equal(calls, 1);
  transport.fetch = async () => Response.json({
    ok: true, status: "sent", messageId: "m".repeat(161),
  });
  await assert.rejects(transport.send(message, "reply"), /did not confirm sent/);
});

test("Xianyu serialized sends wait for each receipt and do not retry failures", async () => {
  const config = configFor();
  const message = normalizeXianyuEvent(event(), config.xianyu.sources[0]);
  const pending = [];
  const transport = new XianyuTransport(config.xianyu, "live", async (_url, options) => {
    return new Promise((resolve, reject) => pending.push({
      resolve, reject, request: JSON.parse(options.body),
    }));
  });
  const first = transport.send(message, "first");
  const secondMessage = normalizeXianyuEvent(
    event({ messageId: "m2" }), config.xianyu.sources[0],
  );
  const second = transport.send(secondMessage, "second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request.text, "first");
  const firstFailure = assert.rejects(first, /delivery failed/);
  pending[0].reject(new Error("fake failure"));
  await firstFailure;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal(pending[1].request.text, "second");
  pending[1].resolve(Response.json({ ok: true, status: "sent", messageId: "out" }));
  assert.equal((await second).status, "sent");
  assert.equal(transport.sendTails.size, 0);
});

test("disabled Xianyu channel cannot send persisted drafts", async (t) => {
  const f = await fixture(t, { outboundMode: "dry-run" });
  const incoming = event();
  await f.post(incoming);
  await f.drain();
  const caseId = caseIdFor(normalizeXianyuEvent(incoming, f.app.config.xianyu.sources[0]));
  const draft = f.app.caseStore.detail(caseId).drafts[0];
  f.app.config.channels.delete("xianyu");
  f.app.transports.xianyu.outboundMode = "live";
  await assert.rejects(f.app.caseManager.sendDraft(caseId, draft.id), /channel is disabled/);
  assert.equal(f.calls.length, 0);
  assert.notEqual(f.app.caseStore.detail(caseId).drafts[0].status, "sent");
});

test("queued Xianyu sends recheck channel enablement before dispatch", async () => {
  const config = configFor();
  const source = config.xianyu.sources[0];
  let enabled = true;
  let finishFirst;
  let calls = 0;
  const transport = new XianyuTransport(config.xianyu, "live", async () => {
    calls++;
    return new Promise((resolve) => { finishFirst = resolve; });
  }, () => enabled);
  const first = transport.send(normalizeXianyuEvent(event(), source), "first");
  const second = transport.send(
    normalizeXianyuEvent(event({ messageId: "m2" }), source), "second",
  );
  const rejected = assert.rejects(second, /channel is disabled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  enabled = false;
  finishFirst(Response.json({ ok: true, status: "sent", messageId: "out" }));
  await first;
  await rejected;
  assert.equal(calls, 1);
});

test("incoming customer text resembling an empty assistant envelope is not discarded", async (t) => {
  const f = await fixture(t);
  const response = await f.post(event({ text: '{"reply_text":"","attachments":[]}' }));
  assert.equal(response.body.results[0].accepted, true);
  await f.drain();
  assert.equal(f.calls.length, 1);
});

test("expired Xianyu draft reconciles a lost sent acknowledgement through receipt lookup only", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const f = await fixture(t);
  const transport = f.app.transports.xianyu;
  const originalFetch = transport.fetch;
  transport.fetch = async (...args) => {
    const response = await originalFetch(...args);
    await response.arrayBuffer();
    throw new Error("fictional lost acknowledgement");
  };
  const incoming = event();
  await f.post(incoming);
  await f.drain();
  const caseId = caseIdFor(normalizeXianyuEvent(incoming, f.app.config.xianyu.sources[0]));
  const draft = f.app.caseStore.detail(caseId).drafts[0];
  assert.notEqual(draft.status, "sent");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/v1/messages/send");
  clock += 300_001;
  transport.fetch = originalFetch;
  const result = await f.app.caseManager.sendDraft(caseId, draft.id);
  assert.equal(result.text.status, "sent");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "/v1/messages/receipt");
  assert.equal(f.calls[1].signatureValid, true);
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
  assert.equal(f.app.caseStore.detail(caseId).drafts[0].status, "sent");
  assert.equal(f.app.status().xianyuSources[0].lastSentAt, null);
});

test("Xianyu stale lookups are deterministic after transport recreation and never fall back to send", async () => {
  const config = configFor();
  const source = config.xianyu.sources[0];
  const timestamp = Date.now() - 301_000;
  const message = normalizeXianyuEvent(event({ timestamp }), source, timestamp);
  const requests = [];
  const lookup = async (url, options) => {
    requests.push(JSON.parse(options.body));
    assert.equal(url, `${source.bridgeUrl}/v1/messages/receipt`);
    assert.equal(options.headers["x-webot-signature"], sign(options.body));
    assert.equal(options.redirect, "error");
    return Response.json({ ok: true, status: "sent", messageId: "saved-receipt" });
  };
  for (let index = 0; index < 2; index++) {
    const transport = new XianyuTransport(config.xianyu, "live", lookup);
    const result = await transport.send(message, "same reply");
    assert.equal(result.messageId, "saved-receipt");
    assert.equal(transport.receipts.size, 0);
  }
  assert.deepEqual(requests[0], requests[1]);
  for (const error of ["receipt_not_found", "send_outcome_unknown", "request_id_conflict"]) {
    let calls = 0;
    const transport = new XianyuTransport(config.xianyu, "live", async (url) => {
      calls++;
      assert.equal(url, `${source.bridgeUrl}/v1/messages/receipt`);
      return Response.json({ ok: false, error, secret }, { status: 409 });
    });
    await assert.rejects(transport.send(message, "same reply"), {
      message: "Xianyu bridge receipt lookup failed",
    });
    assert.equal(calls, 1);
  }
  const malformed = new XianyuTransport(config.xianyu, "live", async (url) => {
    assert.equal(url, `${source.bridgeUrl}/v1/messages/receipt`);
    return Response.json({ ok: true, status: "queued", messageId: "not-sent" });
  });
  await assert.rejects(malformed.send(message, "same reply"), /did not confirm sent/);
});

test("Xianyu receipt lookup retains dry-run, active-source, credential and routing guards", async () => {
  const config = configFor();
  const source = config.xianyu.sources[0];
  const timestamp = Date.now() - 301_000;
  const message = normalizeXianyuEvent(event({ timestamp }), source, timestamp);
  let enabled = true;
  const transport = new XianyuTransport(config.xianyu, "dry-run",
    async () => assert.fail("no network permitted"), () => enabled);
  assert.equal((await transport.send(message, "reply")).dryRun, true);
  transport.outboundMode = "live";
  enabled = false;
  await assert.rejects(transport.send(message, "reply"), /channel is disabled/);
  enabled = true;
  source.enabled = false;
  await assert.rejects(transport.send(message, "reply"), /not bound/);
  source.enabled = true;
  source.secret = "";
  await assert.rejects(transport.send(message, "reply"), /not bound/);
  source.secret = secret;
  await assert.rejects(transport.send({
    ...message, xianyu: { ...message.xianyu, chatId: "different" },
  }, "reply"), /target is invalid/);
});

test("Xianyu outbound validates timestamps before choosing the TTL boundary endpoint", async (t) => {
  const clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const config = configFor();
  const source = config.xianyu.sources[0];
  const paths = [];
  const transport = new XianyuTransport(config.xianyu, "live", async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({ ok: true, status: "sent", messageId: "receipt" });
  });
  const message = normalizeXianyuEvent(event(), source);
  for (const timestamp of [
    undefined, null, "1000000", NaN, Infinity, 0, -1,
    clock + 0.5, Number.MAX_SAFE_INTEGER + 1, clock + 30_001,
  ]) {
    await assert.rejects(transport.send({ ...message, timestamp }, "reply"), /target is invalid/);
  }
  assert.deepEqual(paths, []);
  await transport.send({ ...message, timestamp: clock - 300_000 }, "reply");
  await transport.send({ ...message, timestamp: clock - 300_001 }, "reply");
  await transport.send({ ...message, timestamp: clock + 30_000 }, "reply");
  assert.deepEqual(paths, [
    "/v1/messages/send", "/v1/messages/receipt", "/v1/messages/send",
  ]);
});
