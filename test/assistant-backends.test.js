import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backendConfig } from "../src/assistant-backends.js";
import { childEnvironment, createCodexProvider } from "../src/codex-provider.js";
import { applyControlCommand, parseControlCommand, runtimeOverrides } from "../src/control-commands.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";
import { loadConfig } from "../src/config.js";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-backends-"));
  const backends = {};
  for (const name of ["primary", "group-one", "group-two"]) {
    const home = path.join(directory, name);
    await fs.mkdir(home);
    await fs.writeFile(path.join(home, "config.toml"),
      `model = "${name}-model"\nmodel_catalog_json = "catalog.json"\n`
      + '[model_providers.example]\nenv_key = "EXAMPLE_KEY"\n');
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({
      auth_mode: "apikey", OPENAI_API_KEY: `${name}-synthetic-key`,
      EXAMPLE_KEY: `${name}-synthetic-env-key`,
    }));
    await fs.writeFile(path.join(home, "catalog.json"), JSON.stringify({
      models: [{ slug: `${name}-only` }],
    }));
    backends[name] = { codexHome: home, codexModel: `${name}-model` };
  }
  const config = loadConfig({ WEBOT_DATA_DIR: directory }, {
    assistant: {
      codexBin: process.execPath, codexHome: directory,
      defaultBackend: "primary", backends,
    },
  }).assistant;
  const caseStore = new CaseStore(path.join(directory, "cases.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  t.after(async () => {
    caseStore.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const apply = (text, caseId = "case-one") => applyControlCommand({
    command: parseControlCommand(text), caseId,
    caseStore, sessionStore, config,
  });
  return { directory, config, caseStore, sessionStore, apply };
}

test("backend selection is persisted, isolated, and preserves history", async (t) => {
  const f = await fixture(t);
  const resets = [];
  f.caseStore.resetCodexSession = (id) => resets.push(id);
  await f.sessionStore.append("case-one", "user", "prior conversation");
  const result = await f.apply("/backend group-one");
  assert.match(result.text, /group-one/);
  assert.equal(runtimeOverrides(f.caseStore, "case-one").backend, "group-one");
  assert.equal(runtimeOverrides(f.caseStore, "case-two").backend, "");
  assert.deepEqual(resets, ["case-one"]);
  await f.apply("/backend group-one");
  assert.deepEqual(resets, ["case-one"]);
  assert.equal((await f.sessionStore.history("case-one"))[0].content, "prior conversation");
  const models = await f.apply("/models");
  assert.match(models.text, /group-one-only/);
  assert.doesNotMatch(models.text, /group-two-only|primary-only/);
  assert.match((await f.apply("/status")).text, /当前后端：group-one/);
  const list = await f.apply("/backend list");
  assert.match(list.text, /primary.*group-one.*group-two/);
  assert.doesNotMatch(list.text, /synthetic|auth.json|http|webot-backends/);
  await f.apply("/backend default");
  assert.equal(runtimeOverrides(f.caseStore, "case-one").backend, "");
  assert.deepEqual(resets, ["case-one", "case-one"]);
  await f.apply("/backend group-two");
  await f.apply("/clear");
  assert.equal(runtimeOverrides(f.caseStore, "case-one").backend, "");
});

test("missing or invalid backend authentication never falls back or changes selection", async (t) => {
  const f = await fixture(t);
  await f.apply("/backend group-one");
  assert.match((await f.apply("/backend unknown")).text, /未配置/);
  await fs.writeFile(path.join(f.config.backends["group-two"].codexHome, "auth.json"),
    '{"auth_mode":"apikey"}');
  assert.match((await f.apply("/backend group-two")).text, /未就绪/);
  assert.equal(runtimeOverrides(f.caseStore, "case-one").backend, "group-one");
  delete f.config.backends["group-one"];
  assert.match((await f.apply("/models")).text, /未配置/);
  assert.match((await f.apply("/help")).text, /backend/);
  await f.apply("/backend default");
  assert.equal(runtimeOverrides(f.caseStore, "case-one").backend, "");
});

test("concurrent backends use their own authentication and ignore inherited keys and URLs", async (t) => {
  const f = await fixture(t);
  const captured = [];
  const provider = createCodexProvider(f.config, {
    requesterAccess: () => "owner",
    runCodex: async (config) => {
      const env = childEnvironment(config, {
        OPENAI_API_KEY: "wrong-parent-key",
        EXAMPLE_KEY: "wrong-parent-env-key",
        OPENAI_BASE_URL: "https://wrong.example.invalid",
      });
      captured.push({ home: env.CODEX_HOME, key: env.OPENAI_API_KEY,
        custom: env.EXAMPLE_KEY, url: env.OPENAI_BASE_URL, model: config.codexModel });
      return { text: "done" };
    },
  });
  await Promise.all(["group-one", "group-two"].map((backend) => provider.reply({
    caseId: backend, message: { text: "test" }, history: [],
    runtimeOverrides: { backend },
  })));
  for (const name of ["group-one", "group-two"]) {
    const run = captured.find((item) => item.home === f.config.backends[name].codexHome);
    assert.deepEqual(run, {
      home: f.config.backends[name].codexHome, key: `${name}-synthetic-key`,
      custom: `${name}-synthetic-env-key`, url: undefined, model: `${name}-model`,
    });
  }
  await fs.rm(path.join(f.config.backends["group-two"].codexHome, "auth.json"));
  await assert.rejects(provider.reply({
    caseId: "failure", message: { text: "test" }, history: [],
    runtimeOverrides: { backend: "group-two" },
  }), /未就绪/);
  assert.equal(captured.length, 2);
});

test("profiles reject relative homes and preserve default-backend compatibility", async (t) => {
  const f = await fixture(t);
  assert.equal(backendConfig(f.config).backendId, "primary");
  assert.equal(backendConfig({}).backendId, undefined);
  f.config.backends["group-one"].codexHome = "../relative";
  assert.throws(() => backendConfig(f.config, "group-one"), /有效/);
});

test("backend profiles respect explicit model and effort overrides", async (t) => {
  const f = await fixture(t);
  let selected;
  const provider = createCodexProvider(f.config, {
    runCodex: async (config) => {
      selected = config;
      return { text: "done" };
    },
  });
  await provider.reply({
    caseId: "override", message: { text: "run" }, history: [],
    runtimeOverrides: { backend: "group-two", model: "chosen-model", reasoningEffort: "low" },
  });
  assert.equal(selected.codexModel, "chosen-model");
  assert.equal(selected.reasoningEffort, "low");
  assert.equal(selected.codexHome, f.config.backends["group-two"].codexHome);
});

test("model discovery on non-CPA backends never probes an unrelated remote host", async (t) => {
  const f = await fixture(t);
  await f.apply("/backend group-one");
  const result = await applyControlCommand({
    command: parseControlCommand("/model unavailable-model"),
    caseId: "case-one", caseStore: f.caseStore, sessionStore: f.sessionStore,
    config: f.config, modelProbe: () => assert.fail("must not invoke a remote probe"),
  });
  assert.match(result.text, /模型目录/);
  assert.equal(runtimeOverrides(f.caseStore, "case-one").model, "");
});
