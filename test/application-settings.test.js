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

test("defers connector changes to a controlled reload until active workers drain", async () => {
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
  let draining = false;
  application.caseManager.status = () => ({ active });
  application.caseManager.beginDrain = () => {
    draining = true;
    return { active, draining: true };
  };
  let applied = 0;
  application.applySettings = async () => {
    applied += 1;
  };

  const result = await application.updateSettings({ channels: ["hook"] });
  assert.equal(result.apply.mode, "controlled-drain");
  assert.equal(draining, true);
  assert.equal(applied, 0);

  active = 0;
  await waitFor(() => applied === 1);
  application.caseStore.close();
});
