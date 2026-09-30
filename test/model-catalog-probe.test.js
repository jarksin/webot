import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRegistrationOutput,
  probeAndAddModel,
} from "../src/model-catalog-probe.js";

test("parses the final registration JSON line", () => {
  assert.deepEqual(
    parseRegistrationOutput("noise\n{\"ok\":true,\"selected_model\":\"gpt-test\"}\n"),
    { ok: true, selected_model: "gpt-test" },
  );
});

test("registers remotely and appends exposed models", async () => {
  const calls = [];
  const result = await probeAndAddModel("gpt-6.1-sol", {}, {}, {
    runRemote: async (model) => ({
      ok: true,
      selected_model: model,
      exposed_models: [model, `company-${model}`],
    }),
    addCatalog: async (models) => {
      calls.push(models);
      return {
        addedModels: [`company-${models[0]}`],
        catalogFile: "/tmp/catalog.json",
        modelCount: 2,
      };
    },
  });

  assert.deepEqual(calls, [["gpt-6.1-sol", "company-gpt-6.1-sol"]]);
  assert.equal(result.selected_model, "gpt-6.1-sol");
  assert.equal(result.catalog_model_count, 2);
});
