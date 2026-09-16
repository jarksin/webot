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

test("defers settings reload until active workers have drained", async () => {
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
    return { active, draining: true };
  };
  let applied = 0;
  application.applySettings = async () => {
    applied += 1;
  };

  const saved = await application.updateSettings({
    caseManagement: { autoSend: false },
  });
  assert.equal(saved.caseManagement.autoSend, false);
  assert.equal(draining, true);
  assert.equal(applied, 0);

  active = 0;
  await waitFor(() => applied === 1);
  application.caseStore.close();
});
