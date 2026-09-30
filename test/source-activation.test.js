import assert from "node:assert/strict";
import test from "node:test";
import {
  activationSuppressed,
  createSourceActivator,
  sourceCandidate,
} from "../src/source-activation.js";

test("detects explicit requests not to restart", () => {
  assert.equal(activationSuppressed("先不重启，提交代码就行"), true);
  assert.equal(activationSuppressed("修好后自动重启"), false);
});

test("resolves a committed source candidate newer than the runtime", async () => {
  const result = await sourceCandidate({
    env: {
      WEBOT_RUNTIME_MODE: "source",
      WEBOT_SOURCE_REVISION: "1".repeat(40),
    },
    repoDir: "/repo",
    run: async () => ({ stdout: `${"2".repeat(40)}\n` }),
    readFile: async () => JSON.stringify({ version: "0.6.15" }),
  });
  assert.deepEqual(result, {
    version: "0.6.15",
    revision: "2".repeat(40),
  });
});

test("submits owner source activation to the external broker", async () => {
  let request = null;
  const activator = createSourceActivator({
    env: { WEBOT_ACTIVATION_BROKER_URL: "http://127.0.0.1:19231/" },
    candidate: async () => ({
      version: "0.6.15",
      revision: "3".repeat(40),
    }),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { ok: true, activation_id: "activation-1" };
        },
      };
    },
  });
  const result = await activator.activate({
    caseId: "case-1",
    message: { text: "修复并发布" },
    sourceId: "small-opt",
  });
  assert.equal(result.requested, true);
  assert.equal(request.url, "http://127.0.0.1:19231/api/webot_source_activation");
  assert.deepEqual(JSON.parse(request.options.body), {
    case_id: "case-1",
    requester_access: "owner",
    service: "com.huwatermelon.webot",
    action: "restart",
    expected_version: "0.6.15",
    expected_source_revision: "3".repeat(40),
    expected_source_id: "small-opt",
  });
});

function deferredActivationFixture() {
  const callbacks = [];
  const completions = [];
  const state = { healthy: false, time: 0, requests: 0, fail: false };
  const activator = createSourceActivator({
    env: {},
    ready: () => state.healthy,
    now: () => state.time,
    readinessTimeoutMs: 5000,
    schedule(callback) {
      callbacks.push(callback);
      return {};
    },
    candidate: async () => ({ version: "0.6.37", revision: "a".repeat(40) }),
    fetchImpl: async () => {
      state.requests++;
      if (state.fail) throw new Error("uncertain broker response");
      return { ok: true, json: async () => ({ ok: true, activation_id: "a" }) };
    },
    onDeferredResult: (...args) => completions.push(args),
  });
  const context = { caseId: "owner-case", message: { text: "继续完成" }, sourceId: "small" };
  return { activator, callbacks, completions, state, context };
}

test("deferred activation releases the worker before waiting for connector drain", async () => {
  const f = deferredActivationFixture();
  assert.deepEqual(await f.activator.activate(f.context), {
    requested: false, reason: "waiting-for-ingress",
  });
  assert.equal(f.state.requests, 0);
  await f.callbacks.shift()();
  assert.equal(f.state.requests, 0);
  await f.activator.activate(f.context);
  assert.equal(f.callbacks.length, 1, "same case must not queue duplicate attempts");
  f.state.healthy = true;
  await f.callbacks.shift()();
  assert.equal(f.state.requests, 1);
  assert.equal(f.completions[0][1].requested, true);
  assert.equal(f.callbacks.length, 0);
});

test("deferred activation times out without weakening the health gate", async () => {
  const f = deferredActivationFixture();
  await f.activator.activate(f.context);
  f.state.time = 5000;
  await f.callbacks.shift()();
  assert.match(f.completions[0][2].message, /readiness timed out/);
  assert.equal(f.state.requests, 0);
  assert.equal(f.callbacks.length, 0);
});

test("explicit suppression cancels a pending activation for that owner case", async () => {
  const f = deferredActivationFixture();
  await f.activator.activate(f.context);
  await f.activator.activate({ ...f.context, message: { text: "暂不重启" } });
  f.state.healthy = true;
  await f.callbacks.shift()();
  assert.equal(f.state.requests, 0);
});

test("uncertain deferred broker submission is reported once and never retried", async () => {
  const f = deferredActivationFixture();
  await f.activator.activate(f.context);
  f.state.healthy = true;
  f.state.fail = true;
  await f.callbacks.shift()();
  assert.equal(f.state.requests, 1);
  assert.match(f.completions[0][2].message, /uncertain/);
  assert.equal(f.callbacks.length, 0);
});

test("an immediate healthy activation invalidates the pending attempt", async () => {
  const f = deferredActivationFixture();
  await f.activator.activate(f.context);
  f.state.healthy = true;
  await f.activator.activate(f.context);
  await f.callbacks.shift()();
  assert.equal(f.state.requests, 1);
});
