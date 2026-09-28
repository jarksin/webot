import test from "node:test";
import assert from "node:assert/strict";
import { WebotApplication } from "../src/application.js";
import { loadConfig } from "../src/config.js";

function fixture() {
  const app = new WebotApplication({
    env: {},
    settingsStore: { file: "/fixture/settings.json" },
  });
  app.config = loadConfig({ WEBOT_CHANNELS: "pad" });
  app.config.pad.sources = [
    { id: "active", enabled: true },
    { id: "disabled", enabled: false },
  ];
  app.workspacePolicy = { file: "/fixture/AGENTS.md" };
  app.knowledgeBase = { status: () => ({}), start() {} };
  app.caseStore = { stats: () => ({}) };
  app.caseManager = { status: () => ({}), resumePending: () => ({ queued: 0 }) };
  return app;
}

test("Webot readiness follows its WS, not stale account or aggregate probes", () => {
  const app = fixture();
  let connected = true;
  app.padClients = [{
    source: { id: "active" },
    status: () => ({ connected }),
  }];
  app.padStatuses.set("active", { ready: false, lastError: "HTTP404" });
  assert.equal(app.status().ok, true);
  app.padStatuses.clear();
  assert.equal(app.status().ok, true);
  connected = false;
  app.padStatuses.set("active", { ready: true });
  assert.equal(app.status().ok, false);
  assert.deepEqual(app.status().ingress.degradedSourceIds, ["pad:active"]);
});

test("an enabled source without a WS is unhealthy", () => {
  const app = fixture();
  assert.equal(app.status().ok, false);
  app.config.pad.sources = [];
  assert.equal(app.status().ok, false);
});

test("starting connectors resumes work without account HTTP probes or polling", async () => {
  const app = fixture();
  let starts = 0;
  let resumed = false;
  app.padClients = [{ start() { starts++; } }];
  app.probePads = () => assert.fail("startup must not probe account HTTP endpoints");
  app.caseManager.resumePending = () => {
    resumed = true;
    return { queued: 0 };
  };
  await app.startConnectors();
  assert.equal(starts, 1);
  assert.equal(resumed, true);
  assert.equal(app.padTimer, undefined);
});
