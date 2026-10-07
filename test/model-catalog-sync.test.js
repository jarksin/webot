import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addModelCatalogEntries,
  catalogForModelIds,
  refreshModelCatalog,
  visibleTextModelIds,
} from "../src/model-catalog-sync.js";

function template(slug, priority = 1) {
  return {
    slug,
    display_name: slug,
    description: slug,
    base_instructions: "test instructions",
    supported_reasoning_levels: [{ effort: "high", description: "test" }],
    default_reasoning_level: "high",
    visibility: "list",
    priority,
    use_responses_lite: true,
  };
}

test("keeps canonical text models from a custom provider", () => {
  assert.deepEqual(visibleTextModelIds({
    data: [
      { id: "gpt-6.1-sol" },
      { id: "company-gpt-6.1-sol" },
      { id: "owner/gpt-6.1-sol" },
      { id: "gpt-image-2" },
      { id: "gpt-reserve" },
      { id: "codex-auto-review" },
      { id: "owner/codex-auto-review" },
      { id: "codex-auto-review" },
    ],
  }), ["gpt-6.1-sol", "company-gpt-6.1-sol", "codex-auto-review"]);
});

test("creates metadata for models absent from the prior catalog", () => {
  const catalog = catalogForModelIds({
    models: [
      template("gpt-6-sol", 1),
      template("company-gpt-6-astra", 2),
    ],
  }, ["gpt-6.1-sol", "company-gpt-6.1-sol"], "now");
  assert.equal(catalog.fetched_at, "now");
  assert.deepEqual(catalog.models.map((entry) => entry.slug), [
    "company-gpt-6.1-sol",
    "gpt-6.1-sol",
  ]);
  assert.ok(catalog.models.every((entry) =>
    entry.base_instructions === "test instructions"
  ));
});

test("refreshes the configured catalog from the provider model endpoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webot-model-catalog-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  const catalogFile = path.join(codexHome, "catalog.json");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), [
    'openai_base_url = "http://provider.test/v1"',
    `model_catalog_json = ${JSON.stringify(catalogFile)}`,
  ].join("\n"));
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: "secret",
  }));
  await fs.writeFile(catalogFile, JSON.stringify({
    models: [template("gpt-6-sol")],
  }));

  const result = await refreshModelCatalog(
    { codexHome },
    {},
    {
      fetch: async (url, init) => {
        assert.equal(url, "http://provider.test/v1/models");
        assert.equal(init.headers.authorization, "Bearer secret");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "gpt-6.1-sol" },
              { id: "owner/gpt-6.1-sol" },
              { id: "codex-auto-review" },
            ],
          }),
        };
      },
    },
  );

  assert.equal(result.modelCount, 2);
  assert.deepEqual(
    JSON.parse(await fs.readFile(catalogFile, "utf8")).models
      .map((entry) => entry.slug),
    ["codex-auto-review", "gpt-6.1-sol"],
  );
});

test("adds requested available models without replacing existing entries", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webot-model-add-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  const catalogFile = path.join(codexHome, "catalog.json");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), [
    'openai_base_url = "http://provider.test/v1"',
    `model_catalog_json = ${JSON.stringify(catalogFile)}`,
  ].join("\n"));
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({
    OPENAI_API_KEY: "secret",
  }));
  await fs.writeFile(catalogFile, JSON.stringify({
    models: [template("gpt-6-sol")],
  }));

  const result = await addModelCatalogEntries(
    ["gpt-6.1-sol", "company-gpt-6.1-sol", "codex-auto-review"],
    { codexHome },
    {},
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "gpt-6.1-sol" },
            { id: "company-gpt-6.1-sol" },
            { id: "codex-auto-review" },
          ],
        }),
      }),
    },
  );

  assert.deepEqual(result.addedModels, [
    "gpt-6.1-sol",
    "company-gpt-6.1-sol",
    "codex-auto-review",
  ]);
  assert.deepEqual(
    JSON.parse(await fs.readFile(catalogFile, "utf8")).models
      .map((entry) => entry.slug),
    ["gpt-6-sol", "codex-auto-review", "company-gpt-6.1-sol", "gpt-6.1-sol"],
  );
});
