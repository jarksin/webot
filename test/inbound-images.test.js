import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelImages, markHydratedImage, codexImageInput } from "../src/inbound-images.js";
import { buildCodexArgs, createCodexProvider } from "../src/codex-provider.js";
import { CaseStore } from "../src/case-store.js";
import { WebotApplication } from "../src/application.js";
import { PadTransport } from "../src/transports/pad.js";
import { CaseManager } from "../src/case-manager.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";
import { runCodexAppServer } from "../src/codex-app-server.js";

const scope = {
  transport: "pad", sourceId: "source", chatId: "friend",
  conversationId: "private:source:friend", senderId: "friend",
  direction: "incoming", chatType: "private",
};
const attachment = {
  kind: "image",
  downloadContext: { endpoint: "/api/v1/media/download-img-binary", msgId: 7 },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("only hydrated images from this conversation become native input", () => {
  const verified = markHydratedImage(attachment, { localPath: "/cache/one.png" });
  const current = {
    ...scope, messageId: "current",
    attachments: [{ kind: "image", localPath: "/private/secret.png" }, verified],
    reference: { messageId: "quoted", attachments: [verified] },
  };
  const images = modelImages(current, [{
    message: { ...scope, chatId: "other", attachments: [
      markHydratedImage(attachment, { localPath: "/cache/other.png" }),
    ] },
  }]);
  assert.deepEqual(images, [{ path: "/cache/one.png", messageId: "current" }]);
  assert.deepEqual(modelImages({
    ...current, attachments: [JSON.parse(JSON.stringify(verified))], reference: null,
  }), []);
  assert.deepEqual(codexImageInput("question", images), [
    { type: "text", text: "question" },
    { type: "localImage", path: "/cache/one.png" },
  ]);
  assert.equal(modelImages({ ...scope, attachments: Array.from({ length: 9 }, (_, i) =>
    markHydratedImage(attachment, { localPath: `/cache/${i}.png` })) }).length, 6);
});

test("public direct and quoted images reach the provider without private metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-image-provider-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "codex");
  await fs.writeFile(binary, "", { mode: 0o700 });
  const native = markHydratedImage({
    ...attachment, error: "sensitive download error",
    downloadContext: { secret: "hidden-download-secret" },
  }, { localPath: "/private/inbound/current.png" });
  let received;
  const config = { codexBin: binary, codexHome: directory };
  const provider = createCodexProvider(config, {
    runCodex: async (_config, request) => {
      received = request;
      return { text: "read image" };
    },
  });
  await provider.reply({
    caseId: "case", message: {
      ...scope, messageId: "image-message", text: "[图片]",
      attachments: [native],
      reference: {
        text: "previous", rawContent: "hidden-reference-raw",
        originalMessage: { localPath: "hidden-original-path" },
        attachments: [native],
      },
    },
    history: [],
  });
  assert.equal(received.images.length, 1);
  assert.match(received.prompt, /native visual inputs/);
  assert.match(received.prompt, /Do not access local files/);
  assert.doesNotMatch(received.prompt, /\/private\/|hidden-|sensitive download error/);
  for (const sessionId of ["", "session"]) {
    const args = buildCodexArgs(config, {
      outputPath: "/tmp/output", sessionId, images: received.images,
    });
    assert.equal(args[args.indexOf("--image") + 1], "/private/inbound/current.png");
  }
});

test("unquoted Pad image context is bounded to recent incoming images of this sender and chat", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-image-context-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const now = Date.now();
  const save = (messageId, extra = {}) => store.ingestSyncedMessage({
    ...scope, messageId, timestamp: now - 1000, text: "[图片]",
    attachments: [attachment], ...extra,
  });
  save("old", { timestamp: now - 11 * 60_000 });
  save("first", { timestamp: now - 3000 });
  save("second", { timestamp: now - 2000 });
  save("third");
  save("future", { timestamp: now + 1000 });
  save("other-source", { sourceId: "elsewhere" });
  save("other-chat", { conversationId: "private:source:other" });
  save("other-sender", { senderId: "someone" });
  save("outgoing", { direction: "outgoing" });
  const rows = store.mediaContextBefore({ ...scope, timestamp: now, text: "现在提示这个" });
  assert.deepEqual(rows.map((row) => row.message_id), ["second", "third"]);
  assert.equal(rows[0].message.transport, "pad");
  assert.equal(rows[0].message.attachments[0].downloadContext.msgId, 7);
});

test("framework hydrates public plain and referenced Pad images; errors are safe", async () => {
  const app = Object.create(WebotApplication.prototype);
  app.config = { dataDir: "/cache" };
  app.logger = { warn() {} };
  const requested = [];
  app.serializePadMediaRequest = async (_source, fn) => fn();
  app.transports = { pad: { async downloadInboundAttachment(message) {
    requested.push(message.messageId);
    if (message.messageId === "failed") throw new Error("sensitive-token");
    return { localPath: `/cache/${message.messageId}.png`, mime: "image/png" };
  } } };
  const hydrated = await app.hydratePadMedia({
    ...scope, messageId: "plain", attachments: [attachment],
    reference: { messageId: "quote", attachments: [attachment] },
  });
  assert.deepEqual(requested, ["plain", "quote"]);
  assert.equal(modelImages(hydrated).length, 2);
  const failed = await app.hydratePadMedia({
    ...scope, messageId: "failed", attachments: [attachment],
  });
  assert.equal(failed.attachments[0].error, "image_download_failed");
  assert.equal(modelImages(failed).length, 0);
});

test("Pad cached originals are reused and scoped, and non-image responses fail", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-image-cache-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let bytes = png;
  const transport = new PadTransport({
    sources: [{ id: "source", apiUrl: "http://pad.invalid/api", accessToken: "test" }],
  }, "live", console, async () => {
    calls++;
    return new Response(bytes);
  });
  const message = { ...scope, messageId: "image" };
  const first = await transport.downloadInboundAttachment(message, attachment, directory);
  const second = await transport.downloadInboundAttachment(message, attachment, directory);
  assert.equal(calls, 1);
  assert.equal(first.localPath, second.localPath);
  assert.equal((await fs.stat(first.localPath)).mode & 0o777, 0o600);
  const third = await transport.downloadInboundAttachment({
    ...message, chatId: "different",
  }, attachment, directory);
  assert.notEqual(third.localPath, first.localPath);
  assert.equal(calls, 2);
  await assert.rejects(transport.downloadInboundAttachment(message, {
    ...attachment, downloadContext: { endpoint: "/api/v1/media/download-img-binary/../other" },
  }, directory), /complete image endpoint/);
  bytes = Buffer.from('{"error":"not an image"}');
  await assert.rejects(transport.downloadInboundAttachment({
    ...message, messageId: "bad-image",
  }, attachment, directory), /not a supported image/);
});

test("queued public image and its following text cannot be consumed by text-only steering", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-image-queue-"));
  const store = new CaseStore(path.join(directory, "case.sqlite"));
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const config = loadConfig({ WEBOT_DATA_DIR: directory }, {
    channels: ["pad"],
    pad: { sources: [{
      id: "source", apiUrl: "http://pad.invalid/api", selfId: "self",
      allowedChatIds: ["friend"], allowedSenderIds: ["friend"],
    }] },
    caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
  });
  let release;
  let start;
  const started = new Promise((resolve) => { start = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const turns = [];
  const hydratedIds = [];
  let steered = 0;
  const manager = new CaseManager({
    config, caseStore: store,
    sessionStore: new SessionStore(path.join(directory, "sessions"), 10),
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
    hydratePadMedia: async (message) => {
      if (!message.attachments?.length) return message;
      hydratedIds.push(message.messageId);
      return { ...message, attachments: message.attachments.map((item) =>
        markHydratedImage(item, { localPath: `/cache/${message.messageId}.png` })) };
    },
    provider: {
      async reply(request) {
        turns.push(request);
        if (turns.length === 1) { start(); await gate; }
        return { text: "done", sessionId: "session" };
      },
      async steer() { steered++; return { accepted: true }; },
    },
  });
  const make = (messageId, extra = {}) => ({
    ...scope, messageId, timestamp: Date.now(), text: "question", ...extra,
  });
  const first = await manager.receive(make("first"));
  assert.equal(first.accepted, true);
  await started;
  await manager.receive(make("photo", { text: "[图片]", attachments: [attachment] }));
  await manager.receive(make("followup", { text: "现在提示这个" }));
  assert.equal(steered, 0);
  release();
  const deadline = Date.now() + 3000;
  while ((manager.status().active || turns.length < 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(manager.status().active, 0);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].currentMessageCount, 2);
  assert.match(turns[1].message.text, /现在提示这个/);
  assert.deepEqual(hydratedIds, ["photo"]);
  assert.equal(modelImages(turns[1].message).length, 1);
  const rejected = await manager.receive(make("denied", {
    chatId: "unknown", senderId: "unknown", attachments: [attachment],
  }));
  assert.equal(rejected.accepted, false);
  assert.deepEqual(hydratedIds, ["photo"]);
});

test("app-server sends native image input in fresh and resumed turns", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-image-rpc-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "codex");
  await fs.copyFile(new URL("./fixtures/image-app-server.cjs.fixture", import.meta.url), binary);
  await fs.chmod(binary, 0o700);
  for (const sessionId of ["", "image-test-thread"]) {
    const result = await runCodexAppServer({
      codexBin: binary, codexHome: directory, workingDirectory: directory, timeoutMs: 3000,
    }, {
      sessionId,
      prompt: "Read the screenshot.",
      images: [{ path: "/test/image.png" }],
    });
    assert.equal(result.text, "native image received");
  }
});
