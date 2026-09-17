import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { SettingsStore } from "../src/settings-store.js";
import { serializeConfig } from "../src/settings-store.js";

test("redacts secrets and preserves them by account id", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-settings-"));
  const file = path.join(directory, "settings.json");
  const store = new SettingsStore(file);
  await store.load();
  await store.save({
    assistant: { llmApiKey: "llm-secret" },
    pad: {
      sources: [
        { id: "first", accessToken: "first-secret" },
        { id: "second", accessToken: "second-secret" },
      ],
    },
    telegram: {
      sources: [{
        id: "telegram",
        apiId: "123456",
        apiHash: "telegram-secret",
      }],
    },
  });

  const publicValue = store.publicSettings();
  assert.equal(publicValue.assistant.llmApiKey, "");
  assert.equal(publicValue.assistant.llmApiKeyConfigured, true);
  assert.equal(publicValue.pad.sources[0].accessToken, "");
  assert.equal(publicValue.telegram.sources[0].apiId, "");
  assert.equal(publicValue.telegram.sources[0].apiIdConfigured, true);
  assert.equal(publicValue.telegram.sources[0].apiHash, "");
  assert.equal(publicValue.telegram.sources[0].apiHashConfigured, true);

  await store.save({
    assistant: { llmApiKey: "" },
    pad: {
      sources: [
        { id: "second", accessToken: "" },
        { id: "first", accessToken: "" },
      ],
    },
    telegram: {
      sources: [{
        id: "telegram",
        apiId: "",
        apiHash: "",
      }],
    },
  });
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persisted.assistant.llmApiKey, "llm-secret");
  assert.equal(persisted.pad.sources[0].accessToken, "second-secret");
  assert.equal(persisted.pad.sources[1].accessToken, "first-secret");
  assert.equal(persisted.telegram.sources[0].apiId, "123456");
  assert.equal(persisted.telegram.sources[0].apiHash, "telegram-secret");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("merges partial settings without discarding unrelated sections", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-settings-"));
  const file = path.join(directory, "settings.json");
  const store = new SettingsStore(file);
  await store.save({
    channels: ["pad"],
    outboundMode: "live",
    assistant: { mode: "codex", codexModel: "gpt-test" },
    caseManagement: {
      autoRun: true,
      autoSend: true,
      workerConcurrency: 1,
      ownerIntermediateItems: true,
    },
    pad: {
      sources: [{
        id: "small",
        accessToken: "secret",
        enabled: true,
      }],
    },
  });

  const merged = store.merged({
    caseManagement: { ownerIntermediateItems: false },
  });
  assert.deepEqual(merged.channels, ["pad"]);
  assert.equal(merged.outboundMode, "live");
  assert.equal(merged.assistant.codexModel, "gpt-test");
  assert.deepEqual(merged.caseManagement, {
    autoRun: true,
    autoSend: true,
    workerConcurrency: 1,
    ownerIntermediateItems: false,
  });
  assert.equal(merged.pad.sources[0].accessToken, "secret");
});

test("serialized opt settings omit callback compatibility fields", () => {
  const config = loadConfig({}, {
    channels: ["pad"],
    policy: {
      ownerSenderIds: ["owner_wxid", "wxid_small"],
    },
    pad: {
      sources: [{
        id: "small",
        displayName: "小号",
        selfId: "wxid_small",
        wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "secret",
        ignoreAllowlist: true,
        blockedChatIds: ["blocked@chatroom"],
        blockedSenderIds: ["wxid_blocked"],
        ingressMode: "callback",
        callbackUrl: "http://legacy.invalid/webhooks/pad",
        manageCallback: true,
      }],
    },
  });

  const source = serializeConfig(config).pad.sources[0];
  assert.deepEqual(
    serializeConfig(config).policy.ownerSenderIds,
    ["owner_wxid", "wxid_small"],
  );
  assert.equal(source.wsUrl, "ws://127.0.0.1:18102/ws/wxid_small");
  assert.equal(source.ignoreAllowlist, true);
  assert.deepEqual(source.blockedChatIds, ["blocked@chatroom"]);
  assert.deepEqual(source.blockedSenderIds, ["wxid_blocked"]);
  assert.equal("ingressMode" in source, false);
  assert.equal("callbackUrl" in source, false);
  assert.equal("manageCallback" in source, false);
});

test("loads separate Codex defaults for self chats and other conversations", () => {
  const config = loadConfig({
    WEBOT_CODEX_MODEL: "legacy-model",
    WEBOT_CODEX_REASONING_EFFORT: "low",
    WEBOT_CODEX_SELF_MODEL: "self-model",
    WEBOT_CODEX_SELF_REASONING_EFFORT: "high",
    WEBOT_CODEX_OTHER_MODEL: "other-model",
    WEBOT_CODEX_OTHER_REASONING_EFFORT: "medium",
  });
  assert.equal(config.assistant.codexModel, "legacy-model");
  assert.equal(config.assistant.selfCodexModel, "self-model");
  assert.equal(config.assistant.selfReasoningEffort, "high");
  assert.equal(config.assistant.otherCodexModel, "other-model");
  assert.equal(config.assistant.otherReasoningEffort, "medium");
});

test("new installations use an isolated workspace under the data directory", () => {
  const config = loadConfig({
    WEBOT_DATA_DIR: "/tmp/webot-user-data",
  });
  assert.equal(
    config.assistant.workingDirectory,
    "/tmp/webot-user-data/workspace",
  );
  assert.equal(config.assistant.timeoutMs, 0);
  assert.equal(config.caseManagement.ownerIntermediateItems, false);
  assert.equal(config.caseManagement.groupContextLimit, 50);
  assert.equal(config.caseManagement.groupContextRetentionHours, 168);
  assert.equal(config.caseManagement.groupContextMaxMessages, 2000);
});

test("source installations use the Webot repository as the Codex workdir", () => {
  const config = loadConfig({
    WEBOT_DATA_DIR: "/tmp/webot-user-data",
    WEBOT_RUNTIME_MODE: "source",
    WEBOT_REPO_DIR: "/tmp/webot-repository",
  }, {
    assistant: {
      workingDirectory: "/tmp/webot-user-data/workspace",
    },
  });
  assert.equal(
    config.assistant.workingDirectory,
    "/tmp/webot-repository",
  );
});

test("worker timeout and owner intermediate items are configurable", () => {
  const config = loadConfig({}, {
    assistant: { timeoutMs: -1 },
    caseManagement: {
      ownerIntermediateItems: true,
      groupContextLimit: 300,
      groupContextRetentionHours: 0,
      groupContextMaxMessages: 5,
    },
  });
  assert.equal(config.assistant.timeoutMs, 0);
  assert.equal(config.caseManagement.ownerIntermediateItems, true);
  assert.equal(config.caseManagement.groupContextLimit, 200);
  assert.equal(config.caseManagement.groupContextRetentionHours, 1);
  assert.equal(config.caseManagement.groupContextMaxMessages, 100);
});
