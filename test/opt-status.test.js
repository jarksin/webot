import test from "node:test";
import assert from "node:assert/strict";
import { probeOptSource } from "../src/opt-status.js";

test("checks opt long link and account online state", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-Access-Token"], "secret");
    assert.equal(options.body, "{}");
    return Response.json({
      Success: true,
      Code: 0,
      Data: {
        buildRevision: "0.0.14",
        longLinkReady: true,
        stage: "ready",
      },
    });
  });
  const source = {
    id: "small",
    displayName: "小号",
    enabled: true,
    wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
    apiUrl: "http://127.0.0.1:18102/api",
    accessToken: "secret",
  };

  const status = await probeOptSource(source);
  assert.equal(status.ready, true);
  assert.equal(status.online, null);
  assert.equal(status.runtimeKind, "opt");
  assert.equal(status.buildRevision, "0.0.14");
  assert.deepEqual(calls, ["http://127.0.0.1:18102/api/v1/session/connection-status"]);
});

test("falls back to legacy opt status routes", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url.endsWith("/health") || url.endsWith("/v1/session/connection-status")) {
      return Response.json({}, { status: 404 });
    }
    if (url.endsWith("/Login/LongLinkStatus")) {
      return Response.json({
        Success: true,
        Code: 0,
        Data: {
          buildRevision: "0.0.11",
          longLinkReady: true,
          stage: "ready",
        },
      });
    }
    return Response.json({
      Success: true,
      Code: 0,
      Data: { online: true },
    });
  });
  const source = {
    id: "small",
    displayName: "小号",
    enabled: true,
    wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
    apiUrl: "http://127.0.0.1:18102/api",
    accessToken: "secret",
  };

  const status = await probeOptSource(source);
  assert.equal(status.ready, true);
  assert.equal(status.online, true);
  assert.equal(status.runtimeKind, "opt");
  assert.equal(status.buildRevision, "0.0.11");
  assert.deepEqual(calls, [
    "http://127.0.0.1:18102/api/v1/session/connection-status",
    "http://127.0.0.1:18102/health",
    "http://127.0.0.1:18102/api/Login/LongLinkStatus",
    "http://127.0.0.1:18102/api/User/GetOnlineInfo",
  ]);
});

test("account errors and offline state cannot be hidden by aggregate health", async (context) => {
  const source = {
    id: "small", enabled: true, wsUrl: "ws://pad.invalid/ws/account",
    apiUrl: "http://pad.invalid/api", accessToken: "secret",
  };
  for (const status of [200, 401, 403, 503]) {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async (url) => {
      calls++;
      assert.ok(url.endsWith("/v1/session/connection-status"));
      return Response.json(status === 200
        ? { Success: true, Data: { stage: "stopped", longLinkReady: false } }
        : { Success: false, Message: "account unavailable" }, { status });
    });
    const result = await probeOptSource(source);
    assert.equal(result.ready, false);
    assert.equal(calls, 1);
    assert.equal(result.state, status === 200 ? "stopped" : "error");
  }
});
