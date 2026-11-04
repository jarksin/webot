import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebotApplication } from "../src/application.js";
import { SettingsStore } from "../src/settings-store.js";

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

test("channel enable changes preserve credentials and other source settings", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-enable-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.save({
    pad: { sources: [
      { id: "main", enabled: true, accessToken: "main-secret", keywordOnly: true },
      { id: "small", enabled: false, accessToken: "small-secret" },
    ] },
  });
  const application = new WebotApplication({ settingsStore });
  application.updateSettings = async (patch) => patch;
  const patch = await application.setPadSourceEnabled("small", true);
  assert.deepEqual(patch.pad.sources, [
    { id: "main", enabled: true, accessToken: "main-secret", keywordOnly: true },
    { id: "small", enabled: true, accessToken: "small-secret" },
  ]);
  await assert.rejects(application.setPadSourceEnabled("missing", true), /unknown/);
  await assert.rejects(application.setPadSourceEnabled("main", "false"), /boolean/);
});

test("applies prompt and worker settings dynamically without draining active workers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-settings-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  const application = new WebotApplication({
    settingsStore,
    env: {
      ...process.env,
      WEBOT_DATA_DIR: directory,
      WEBOT_RUNTIME_MODE: "test",
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();

  let active = 1;
  let draining = false;
  application.caseManager.status = () => ({ active });
  application.caseManager.beginDrain = () => {
    draining = true;
    throw new Error("dynamic settings must not drain workers");
  };

  const result = await application.updateSettings({
    assistant: { systemPrompt: "dynamic prompt" },
    caseManagement: { autoSend: false },
  });
  assert.equal(result.settings.caseManagement.autoSend, false);
  assert.equal(result.apply.mode, "dynamic");
  assert.equal(draining, false);
  assert.equal(active, 1);

  const agent = await application.agentDocument();
  await application.saveAgentDocument(`${agent.content}\n# hot update\n`, agent.hash);
  await application.saveKnowledgeDocument(
    "owner/hot-update.md",
    "---\napproved: true\naudience: owner\n---\n# Hot update\n",
  );
  assert.equal(active, 1);

  application.caseStore.close();
});

test("manual Access Code replaces an old source token file and is shown as configured", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-settings-"));
  const tokenFile = path.join(directory, "access-code");
  await fs.writeFile(tokenFile, "old-file-token\n");
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.save({
    channels: ["pad"],
    pad: {
      sources: [{
        id: "main",
        selfId: "wxid_main",
        enabled: false,
        wsUrl: "ws://127.0.0.1:18102/ws/wxid_main",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "",
        accessTokenFile: tokenFile,
      }],
    },
  });
  const application = new WebotApplication({
    settingsStore,
    env: {
      ...process.env,
      WEBOT_DATA_DIR: directory,
      WEBOT_RUNTIME_MODE: "test",
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();

  const result = await application.updateSettings({
    pad: {
      sources: [{
        id: "main",
        selfId: "wxid_main",
        enabled: false,
        wsUrl: "ws://127.0.0.1:18102/ws/wxid_main",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "new-inline-token",
        accessTokenFile: tokenFile,
      }],
    },
  });
  const persisted = JSON.parse(
    await fs.readFile(path.join(directory, "settings.json"), "utf8"),
  );

  assert.equal(persisted.pad.sources[0].accessToken, "new-inline-token");
  assert.equal(persisted.pad.sources[0].accessTokenFile, "");
  assert.equal(application.config.pad.sources[0].accessToken, "new-inline-token");
  assert.equal(result.settings.pad.sources[0].accessTokenConfigured, true);
  application.caseStore.close();
});

test("connector reloads wait for idle without preventing new tasks from running", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-settings-drain-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  const application = new WebotApplication({
    settingsStore,
    env: {
      ...process.env,
      WEBOT_DATA_DIR: directory,
      WEBOT_RUNTIME_MODE: "test",
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();

  let active = 1;
  let queued = 0;
  let draining = false;
  application.caseManager.status = () => ({ active, queued });
  application.caseManager.idle = () => active === 0 && queued === 0;
  application.caseManager.reserveIdle = () => ({ release() {} });
  application.caseManager.beginDrain = () => {
    draining = true;
    return { active, draining: true };
  };
  let applied = 0;
  application.applySettings = async () => {
    applied += 1;
  };

  const result = await application.updateSettings({ channels: ["hook"] });
  assert.equal(result.apply.mode, "controlled-idle");
  assert.equal(draining, false);
  assert.equal(applied, 0);

  active = 0;
  queued = 1;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(applied, 0, "queued work must have priority over a reload");
  queued = 0;
  active = 1;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(applied, 0, "a new worker must be allowed to finish");
  active = 0;
  await waitFor(() => applied === 1);
  application.caseStore.close();
});

test("paused workers apply connector changes while retaining queued and forced jobs", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-paused-settings-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.save({ channels: ["hook"], caseManagement: { autoRun: false }, pad: { sources: [{
    id: "fixture", selfId: "bot", enabled: false, wsUrl: "wss://old.invalid/ws/bot",
  }] } });
  const application = new WebotApplication({ settingsStore,
    env: { ...process.env, WEBOT_DATA_DIR: directory, WEBOT_RUNTIME_MODE: "test" },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();
  t.after(async () => { await application.stopConnectors(); application.caseStore.close(); await fs.rm(directory, { recursive: true, force: true }); });
  application.setWorkersPaused(true);
  await application.startConnectors();
  const message = { transport: "hook", messageId: "queued", senderId: "user",
    chatType: "private", chatId: "user", text: "pending question", timestamp: Date.now() };
  const received = await application.caseManager.receive(message);
  application.runCase(received.caseId);
  assert.equal(application.caseManager.forced.has(received.caseId), true);
  const result = await application.updateSettings({ pad: { sources: [{
    id: "fixture", wsUrl: "wss://new.invalid/ws/bot",
  }] } });
  assert.equal(result.apply.mode, "controlled-restart");
  assert.equal(application.config.pad.sources[0].wsUrl, "wss://new.invalid/ws/bot");
  assert.equal(application.caseManager.paused(), true);
  assert.equal(application.caseManager.active, 0);
  assert.deepEqual(application.caseManager.queue, [received.caseId]);
  assert.equal(application.caseManager.forced.has(received.caseId), true);
  assert.equal(application.caseStore.pendingMessages(received.caseId).length, 1);
});

test("pending settings and connection tests use the saved account before it replaces running config", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-pending-settings-"));
  const settingsStore = new SettingsStore(path.join(directory, "settings.json"));
  await settingsStore.save({ channels: ["hook"], pad: { sources: [{
    id: "fixture", selfId: "old-bot", enabled: true, wsUrl: "wss://old.invalid/ws/bot",
  }] } });
  const application = new WebotApplication({ settingsStore,
    env: { ...process.env, WEBOT_DATA_DIR: directory, WEBOT_RUNTIME_MODE: "test" },
    logger: { info() {}, warn() {}, error() {} },
  });
  await application.initialize();
  t.after(async () => { await application.stopConnectors(); application.caseStore.close(); await fs.rm(directory, { recursive: true, force: true }); });
  application.caseManager.active = 1;
  const result = await application.updateSettings({ pad: { sources: [{
    id: "fixture", selfId: "new-bot", enabled: false, wsUrl: "wss://new.invalid/ws/new-bot", accessToken: "private-token",
  }] } });
  assert.equal(result.apply.mode, "controlled-idle");
  assert.equal(application.config.pad.sources[0].selfId, "old-bot");
  const visible = application.settings().pad.sources[0];
  assert.equal(visible.selfId, "new-bot");
  assert.equal(visible.wsUrl, "wss://new.invalid/ws/new-bot");
  assert.equal(visible.accessToken, "");
  assert.equal(visible.accessTokenConfigured, true);
  assert.equal((await application.testOpt("fixture")).state, "disabled");
  application.caseManager.active = 0;
  application.setWorkersPaused(true);
  await application.updateSettings({ pad: { sources: [{
    id: "fixture", wsUrl: "wss://latest.invalid/ws/new-bot",
  }] } });
  assert.equal(application.pendingSettings, null);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(application.config.pad.sources[0].selfId, "new-bot");
  assert.equal(application.config.pad.sources[0].wsUrl, "wss://latest.invalid/ws/new-bot");
});
