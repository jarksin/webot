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

test("QW account readiness uses its own status fields rather than personal Pad stages", async (context) => {
  const source = {
    id: "qw", enabled: true, wsUrl: "wss://gateway.invalid/ws/account",
    apiUrl: "https://gateway.invalid/api", accessToken: "secret",
  };
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, "https://gateway.invalid/api/v1/session/connection-status");
    assert.equal(options.method, "POST");
    return Response.json({
      Success: true, Code: 0, Data: {
        protocol: "qw_pad", state: "maintaining", is_login: true,
        online: true, authenticated: true, maintenance_running: true,
        transport_connected: true, binding_accepted: true,
        last_positive_read: "2026-01-01T00:00:00Z",
      },
    });
  });
  const result = await probeOptSource(source);
  assert.equal(result.ready, true);
  assert.equal(result.online, true);
  assert.equal(result.runtimeKind, "qw");
  assert.equal(result.state, "maintaining");
  assert.equal(result.loginState, "maintaining");
  assert.equal(result.lastError, "");
  assert.equal(calls, 1);
});

test("QW transport or login alone cannot make an incomplete account ready", async (context) => {
  const source = {
    id: "qw", enabled: true, wsUrl: "wss://gateway.invalid/ws/account",
    apiUrl: "https://gateway.invalid/api", accessToken: "secret",
  };
  const required = [
    "online", "authenticated", "maintenance_running", "transport_connected", "binding_accepted",
  ];
  for (const field of required) {
    for (const value of [false, undefined, "true"]) {
      const data = {
        protocol: "qw_pad", state: "maintaining", is_login: true,
        stage: "ready", longLinkReady: true,
        ...Object.fromEntries(required.map((name) => [name, true])),
        [field]: value,
      };
      let calls = 0;
      context.mock.method(globalThis, "fetch", async () => {
        calls++;
        return Response.json({ Success: true, Code: 0, Data: data });
      });
      const result = await probeOptSource(source);
      assert.equal(result.ready, false, `${field}=${value}`);
      assert.equal(result.online, data.online === true);
      assert.equal(result.runtimeKind, "qw");
      assert.equal(result.state, "maintaining");
      assert.equal(calls, 1);
    }
  }
});
