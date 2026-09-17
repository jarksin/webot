import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyControlCommand,
  parseControlCommand,
  runtimeOverrides,
} from "../src/control-commands.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";

test("parses stable owner control commands", () => {
  assert.deepEqual(parseControlCommand("/models"), {
    type: "model",
    action: "list",
  });
  assert.deepEqual(parseControlCommand("/modes"), {
    type: "model",
    action: "list",
  });
  assert.deepEqual(parseControlCommand("/model list"), {
    type: "model",
    action: "list",
  });
  assert.deepEqual(parseControlCommand("/model gpt-5 task"), {
    type: "model",
    action: "set",
    model: "gpt-5",
    task: "task",
  });
  assert.deepEqual(parseControlCommand("/new"), {
    type: "clear",
    action: "reset",
  });
  assert.deepEqual(parseControlCommand("/sessions"), {
    type: "session",
    action: "list",
    name: "",
  });
  assert.deepEqual(parseControlCommand("/session list"), {
    type: "session",
    action: "invalid",
    name: "",
  });
  assert.deepEqual(parseControlCommand("/session new project-a"), {
    type: "session",
    action: "new",
    name: "project-a",
  });
  assert.deepEqual(parseControlCommand("/session main"), {
    type: "session",
    action: "use",
    name: "main",
  });
  assert.equal(parseControlCommand("/unknown"), null);
});

test("applies model and effort overrides without invoking a provider", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-command-"));
  const codexHome = path.join(directory, "codex");
  await fs.mkdir(codexHome);
  await fs.writeFile(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify({ models: [{ slug: "gpt-test" }, { slug: "gpt-other" }] }),
  );
  await fs.writeFile(
    path.join(codexHome, "custom-models.json"),
    JSON.stringify({
      models: [
        { slug: "claude-opus-5" },
        { slug: "gpt-image-2" },
        { slug: "codex-auto-review" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    'model_catalog_json = "custom-models.json"\n',
  );
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  const config = {
    codexHome,
    codexModel: "gpt-test",
    reasoningEffort: "high",
    serviceTier: "standard",
  };

  const model = await applyControlCommand({
    command: parseControlCommand("/model gpt-other"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(model.text, /gpt-other/);
  assert.equal(runtimeOverrides(caseStore, "case-1").model, "gpt-other");

  const customModel = await applyControlCommand({
    command: parseControlCommand("/model claude-opus-5"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(customModel.text, /claude-opus-5/);
  assert.equal(runtimeOverrides(caseStore, "case-1").model, "claude-opus-5");

  const models = await applyControlCommand({
    command: parseControlCommand("/modes"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(models.text, /claude-opus-5/);
  assert.doesNotMatch(models.text, /gpt-image-2/);
  assert.doesNotMatch(models.text, /codex-auto-review/);

  const effort = await applyControlCommand({
    command: parseControlCommand("/effort low"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(effort.text, /low/);
  assert.equal(runtimeOverrides(caseStore, "case-1").reasoningEffort, "low");

  await sessionStore.append("case-1", "user", "old context");
  const cleared = await applyControlCommand({
    command: parseControlCommand("/clear"),
    caseId: "case-1",
    caseStore,
    sessionStore,
    config,
  });
  assert.match(cleared.text, /已清理当前会话/);
  assert.deepEqual(runtimeOverrides(caseStore, "case-1"), {
    model: "",
    reasoningEffort: "",
  });
  assert.deepEqual(await sessionStore.history("case-1"), []);
  caseStore.close();
});

test("creates, switches, lists, and deletes isolated named sessions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-session-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  const common = {
    caseStore,
    sessionStore,
    config: {},
    scopeCaseId: "wechat:small:self-pair:owner",
  };

  const created = await applyControlCommand({
    ...common,
    caseId: common.scopeCaseId,
    command: parseControlCommand("/session new project-a"),
  });
  assert.match(created.text, /已新建并切换/);
  const project = caseStore.activeSession(common.scopeCaseId);
  assert.equal(project.name, "project-a");
  assert.notEqual(project.target_case_id, common.scopeCaseId);
  caseStore.setRuntimeSetting(
    `assistant_effort:${project.target_case_id}`,
    "low",
  );
  assert.equal(
    runtimeOverrides(caseStore, project.target_case_id).reasoningEffort,
    "low",
  );
  assert.equal(
    runtimeOverrides(caseStore, common.scopeCaseId).reasoningEffort,
    "",
  );

  const listed = await applyControlCommand({
    ...common,
    caseId: project.target_case_id,
    command: parseControlCommand("/sessions"),
  });
  assert.match(listed.text, /\* project-a/);
  assert.match(listed.text, /- main/);

  const activeDelete = await applyControlCommand({
    ...common,
    caseId: project.target_case_id,
    command: parseControlCommand("/session delete project-a"),
  });
  assert.match(activeDelete.text, /不能删除当前/);

  await applyControlCommand({
    ...common,
    caseId: project.target_case_id,
    command: parseControlCommand("/session main"),
  });
  assert.equal(
    caseStore.activeSession(common.scopeCaseId).target_case_id,
    common.scopeCaseId,
  );

  const deleted = await applyControlCommand({
    ...common,
    caseId: common.scopeCaseId,
    command: parseControlCommand("/session delete project-a"),
  });
  assert.match(deleted.text, /已删除/);
  assert.deepEqual(
    caseStore.listSessions(common.scopeCaseId).map((row) => row.name),
    ["main"],
  );
  caseStore.close();
});

test("keeps stop replies concise", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-stop-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  for (const stopped of [false, true]) {
    const result = await applyControlCommand({
      command: parseControlCommand("/stop"),
      caseId: "case-1",
      caseStore,
      sessionStore,
      config: {},
      stopped,
    });
    assert.equal(result.text, "任务已停止");
  }
  caseStore.close();
});
