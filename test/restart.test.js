import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { WebotApplication } from "../src/application.js";
import { createSourceActivator, sourceCandidate } from "../src/source-activation.js";

test("explicit console restart can resolve the current committed revision", async () => {
  const options = {
    env: { WEBOT_RUNTIME_MODE: "source", WEBOT_SOURCE_REVISION: "a".repeat(40) },
    repoDir: "/fixture",
    run: async () => ({ stdout: "a".repeat(40) }),
    readFile: async () => '{"version":"0.6.40"}',
  };
  assert.equal(await sourceCandidate(options), null);
  assert.equal((await sourceCandidate({ ...options, includeCurrent: true })).revision, "a".repeat(40));
});

test("console restart submits only the pinned revision and source through the parent broker", async () => {
  let payload;
  const activation = createSourceActivator({
    now: () => 123,
    candidate: async ({ includeCurrent }) => {
      assert.equal(includeCurrent, true);
      return { revision: "a".repeat(40), version: "0.6.40" };
    },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ ok: true, activation_id: "fixture" }) };
    },
  });
  const result = await activation.restartFromConsole({ sourceId: "fixture-source" });
  assert.equal(result.requested, true);
  assert.equal(payload.case_id, "console-restart-123");
  assert.equal(payload.expected_source_id, "fixture-source");
  assert.equal(payload.expected_source_revision, "a".repeat(40));
});

function restartApplication(restartFromConsole) {
  const app = Object.create(WebotApplication.prototype);
  app.env = { WEBOT_RUNTIME_MODE: "source" };
  app.config = { pad: { sources: [{ id: "fixture", enabled: true }] } };
  app.restartResult = null;
  app.restartOperation = null;
  app.status = () => ({ ok: true });
  app.sourceActivator = { restartFromConsole };
  return app;
}

test("duplicate clicks share one request and acceptance is not completion", async () => {
  let calls = 0;
  let release;
  const app = restartApplication(async () => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
    return { requested: true, revision: "a".repeat(40) };
  });
  const first = app.requestRestart();
  const second = app.requestRestart();
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].requested, true);
  assert.match(results[0].message, /等待/);
  assert.deepEqual(await app.requestRestart(), results[0]);
  assert.equal(calls, 1);
});

test("a known deferred reload failure permits a corrected console retry", async () => {
  const app = restartApplication(async () => ({ requested: true }));
  app.restartResult = { requested: false, failed: true, message: "known failure" };
  assert.equal((await app.requestRestart()).requested, true);
});

test("uncertain submissions never retry; known rejections can be corrected", async () => {
  for (const uncertain of [true, false]) {
    let calls = 0;
    const app = restartApplication(async () => {
      calls++;
      const error = new Error("fixture broker failure");
      error.activationUncertain = uncertain;
      throw error;
    });
    if (uncertain) {
      assert.equal((await app.requestRestart()).requested, false);
      await app.requestRestart();
    } else {
      await assert.rejects(app.requestRestart(), /fixture broker failure/);
      await assert.rejects(app.requestRestart(), /fixture broker failure/);
    }
    assert.equal(calls, uncertain ? 1 : 2);
  }
  const app = restartApplication(() => assert.fail("must not submit"));
  app.status = () => ({ ok: false });
  await assert.rejects(app.requestRestart(), /尚未就绪/);
});

test("restart endpoint requires a local same-origin console nonce and explicit confirmation", async (t) => {
  let calls = 0;
  const config = loadConfig({ WEBOT_HOST: "127.0.0.1", WEBOT_PORT: "0" });
  const application = {
    config,
    startConnectors() {},
    stopConnectors() {},
    status: () => ({ ok: true, runtime: {} }),
    requestRestart: async () => {
      calls++;
      return { requested: true, message: "waiting" };
    },
  };
  const server = createServer({ application, config, logger: { error() {} } });
  const address = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const html = await fetch(base).then((r) => r.text());
  const token = html.match(/name="webot-restart-token" content="([a-f0-9]{64})"/)?.[1];
  assert.ok(token);
  async function post(headers, body = { confirm: true }) {
    return fetch(`${base}/api/admin/service/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  const correct = { Origin: base, "X-Webot-Restart-Token": token };
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ ...correct, Origin: "http://evil.invalid" })).status, 403);
  assert.equal((await post({ ...correct, "X-Webot-Restart-Token": "wrong" })).status, 403);
  assert.equal((await post(correct, {})).status, 400);
  assert.equal(calls, 0);
  const response = await post(correct);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).restart.requested, true);
  assert.equal(calls, 1);
});
