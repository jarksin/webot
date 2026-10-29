import test from "node:test";
import assert from "node:assert/strict";
import { handlePadAutoAction } from "../src/pad-auto-actions.js";
import { normalizePadEnvelope } from "../src/normalize.js";
import { normalizeSource } from "../src/ingress-sources.js";

function fixture() {
  const source = normalizeSource({ id: "fixture", selfId: "bot", enabled: true,
    autoAcceptFriends: true, autoReceiveRedPackets: true }, {}, {});
  const calls = [];
  const states = new Map();
  const dependencies = {
    config: { channels: new Set(["pad"]), pad: { sources: [source] }, outboundMode: "live" },
    caseStore: { runtimeSetting: (key, fallback) => states.get(key) ?? fallback,
      setRuntimeSetting: (key, value) => states.set(key, value) },
    transport: { request: async (...args) => {
      calls.push(args);
      return { ok: true, result: { Data: { sendUserName: "sender", timingIdentifier: "timing" } } };
    } },
    logger: { info() {}, error() {} },
  };
  const message = { transport: "pad", sourceId: source.id, direction: "incoming",
    senderId: "sender", chatId: "sender", messageId: "event-1", messageType: 37,
    friendRequest: { friend_request_id: "request-1", accept_ready: true, from_user_name: "sender" } };
  return { source, calls, states, dependencies, message };
}

test("accepts a persisted friend request once, even with concurrent WS duplicates", async () => {
  const f = fixture();
  await Promise.all([handlePadAutoAction(f.message, f.dependencies), handlePadAutoAction(f.message, f.dependencies)]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "/v1/contacts/accept-request");
  assert.equal(f.calls[0][1].friend_request_id, "request-1");
  assert.equal(f.calls[0][2].sourceId, "fixture");
  assert.equal(JSON.parse([...f.states.values()][0]).status, "succeeded");
});

test("receives then opens a packet with gateway-provided timing context; replay is suppressed", async () => {
  const f = fixture();
  Object.assign(f.message, { messageType: 49, rawContent: "<packet/>",
    app: { red_packet: { app_message_type: 2001, pay_message_id: "packet-1" } } });
  await handlePadAutoAction(f.message, f.dependencies);
  await handlePadAutoAction({ ...f.message, messageId: "different-replay-id" }, f.dependencies);
  assert.deepEqual(f.calls.map(([route]) => route), [
    "/v1/payments/receive-red-packet", "/v1/payments/open-red-packet",
  ]);
  assert.equal(f.calls[1][1].TimingIdentifier, "timing");
  assert.equal(f.calls[1][1].SendUserName, "sender");
  assert.equal(f.calls[1][1].Xml, "<packet/>");
});

test("failures and uncertain responses are recorded and never automatically retried", async () => {
  const f = fixture();
  f.dependencies.transport.request = async () => { throw new Error("timeout"); };
  assert.match((await handlePadAutoAction(f.message, f.dependencies)).reason, /failed_or_uncertain/);
  assert.match((await handlePadAutoAction(f.message, f.dependencies)).reason, /already_attempted/);
  assert.equal(JSON.parse([...f.states.values()][0]).error, "timeout");
});

test("requires the enabled source policy and inbound direction, respects blocks and dry-run", async () => {
  for (const change of [
    (f) => { f.source.autoAcceptFriends = false; },
    (f) => { f.source.enabled = false; },
    (f) => { f.message.direction = "outgoing"; },
    (f) => { f.message.sourceId = "another-account"; },
    (f) => { f.source.blockedSenderIds.add("sender"); },
    (f) => { f.dependencies.config.channels.clear(); },
    (f) => { f.dependencies.config.outboundMode = "dry-run"; },
  ]) {
    const f = fixture(); change(f);
    await handlePadAutoAction(f.message, f.dependencies);
    assert.equal(f.calls.length, 0);
    assert.equal(f.states.size, 0);
  }
  const source = normalizeSource({ id: "default", selfId: "bot" }, {}, {});
  assert.equal(source.autoAcceptFriends, false);
  assert.equal(source.autoReceiveRedPackets, false);
});

test("normalization retains the gateway friend request ID used for acceptance", () => {
  const f = fixture();
  const [message] = normalizePadEnvelope({ schema: "wechatpad.message.v2", messages: [{
    id: "event", type: 37, sender_id: "sender", recipient_id: "bot", content: "request",
    friend_request: f.message.friendRequest,
  }] }, f.source);
  assert.equal(message.friendRequest.friend_request_id, "request-1");
  assert.equal(message.direction, "incoming");
});

test("does not open a packet without returned timing context or treat a transfer as a packet", async () => {
  const f = fixture();
  Object.assign(f.message, { messageType: 49, rawContent: "<packet/>",
    app: { red_packet: { app_message_type: 2000 } } });
  assert.equal(await handlePadAutoAction(f.message, f.dependencies), null);
  f.message.app.red_packet.app_message_type = 2001;
  f.dependencies.transport.request = async (...args) => {
    f.calls.push(args); return { ok: true, result: { Data: {} } };
  };
  assert.match((await handlePadAutoAction(f.message, f.dependencies)).reason, /failed_or_uncertain/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "/v1/payments/receive-red-packet");
});
