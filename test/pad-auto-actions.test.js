import test from "node:test";
import assert from "node:assert/strict";
import { handlePadAutoAction } from "../src/pad-auto-actions.js";
import { normalizePadEnvelope } from "../src/normalize.js";
import { normalizeSource } from "../src/ingress-sources.js";
import { PadTransport } from "../src/transports/pad.js";
import { WebotApplication } from "../src/application.js";

function fixture() {
  const source = normalizeSource({ id: "fixture", selfId: "bot", enabled: true,
    autoAcceptFriends: true, autoReceiveRedPackets: true }, {}, {});
  const calls = [];
  const replies = [];
  const generations = [];
  const states = new Map();
  const dependencies = {
    config: { channels: new Set(["pad"]), pad: { sources: [source] }, outboundMode: "live" },
    caseStore: { runtimeSetting: (key, fallback) => states.get(key) ?? fallback,
      setRuntimeSetting: (key, value) => states.set(key, value) },
    transport: { request: async (...args) => {
      calls.push(args);
      return { ok: true, result: { Data: { sendUserName: "sender", timingIdentifier: "timing" } } };
    }, send: async (...args) => { replies.push(args); } },
    generateReply: async (...args) => {
      generations.push(args);
      return args[1] === "accept_friend" ? "你好，很高兴认识你。" : "谢谢你的心意！";
    },
    logger: { info() {}, error() {} },
  };
  const message = { transport: "pad", sourceId: source.id, direction: "incoming",
    senderId: "sender", chatId: "sender", messageId: "event-1", messageType: 37,
    friendRequest: { friend_request_id: "request-1", accept_ready: true, from_user_name: "sender" } };
  return { source, calls, replies, generations, states, dependencies, message };
}

test("accepts a persisted friend request once, even with concurrent WS duplicates", async () => {
  const f = fixture();
  await Promise.all([handlePadAutoAction(f.message, f.dependencies), handlePadAutoAction(f.message, f.dependencies)]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "/v1/contacts/accept-request");
  assert.equal(f.calls[0][1].friend_request_id, "request-1");
  assert.equal(f.calls[0][2].sourceId, "fixture");
  assert.equal(JSON.parse([...f.states.values()][0]).status, "succeeded");
  assert.equal(JSON.parse([...f.states.values()][0]).replyStatus, "succeeded");
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0][0].replyTarget, "sender");
  assert.equal(f.replies[0][1], "你好，很高兴认识你。");
  assert.equal(f.generations.length, 1);
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
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0][1], "谢谢你的心意！");
});

test("failures and uncertain responses are recorded and never automatically retried", async () => {
  const f = fixture();
  f.dependencies.transport.request = async () => { throw new Error("timeout"); };
  assert.match((await handlePadAutoAction(f.message, f.dependencies)).reason, /failed_or_uncertain/);
  assert.match((await handlePadAutoAction(f.message, f.dependencies)).reason, /already_attempted/);
  assert.equal(JSON.parse([...f.states.values()][0]).error, "timeout");
  assert.equal(f.replies.length, 0);
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
  assert.equal(f.replies.length, 0);
});

test("welcomes the applicant rather than the system event chat and respects model silence", async () => {
  const f = fixture();
  f.dependencies.generateReply = async () => "你好，我是小水瓜。";
  f.message.chatId = "fmessage";
  f.message.replyTarget = "fmessage";
  await handlePadAutoAction(f.message, f.dependencies);
  assert.equal(f.replies[0][0].chatType, "private");
  assert.equal(f.replies[0][0].replyTarget, "sender");
  assert.equal(f.replies[0][1], "你好，我是小水瓜。");
  const silent = fixture();
  silent.dependencies.generateReply = async () => "";
  await handlePadAutoAction(silent.message, silent.dependencies);
  assert.equal(silent.calls.length, 1);
  assert.equal(silent.replies.length, 0);
});

test("a failed welcome keeps acceptance successful and replay cannot repeat either operation", async () => {
  const f = fixture();
  f.dependencies.transport.send = async () => { throw new Error("reply timeout"); };
  assert.match((await handlePadAutoAction(f.message, f.dependencies)).reason, /succeeded_reply_failed/);
  const state = JSON.parse([...f.states.values()][0]);
  assert.equal(state.status, "succeeded");
  assert.equal(state.replyStatus, "failed_or_uncertain");
  await handlePadAutoAction(f.message, f.dependencies);
  assert.equal(f.calls.length, 1);
});

test("group packet thanks use the source transport and mention the packet sender after opening", async () => {
  const f = fixture();
  const sends = [];
  f.source.apiUrl = "http://fixture.invalid/api";
  const pad = new PadTransport({ sources: [f.source] }, "live", f.dependencies.logger,
    async (url, options) => {
      assert.equal(f.calls.length, 2, "thanks must follow successful opening");
      sends.push({ url, body: JSON.parse(options.body) });
      return { ok: true, text: async () => JSON.stringify({ Code: 0, Success: true }) };
    });
  f.dependencies.transport.send = (...args) => pad.send(...args);
  Object.assign(f.message, { messageType: 49, rawContent: "<packet/>",
    chatType: "group", chatId: "room@chatroom", replyTarget: "room@chatroom",
    app: { red_packet: { app_message_type: 2001, pay_message_id: "packet-1" } } });
  await handlePadAutoAction(f.message, f.dependencies);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, "http://fixture.invalid/api/v1/messages/send-text");
  assert.equal(sends[0].body.to, "room@chatroom");
  assert.equal(sends[0].body.at, "sender");
  assert.match(sends[0].body.content, /谢谢你的心意/);
});


test("event reply uses the policy-aware provider with public access and no raw gateway data", async () => {
  const f = fixture();
  let request;
  const application = {
    config: {},
    padAutomaticReplies: 0,
    providerFor(config, options) {
      assert.equal(options.publicOnly, true);
      return { provider: { reply: async (value) => {
        assert.equal(application.padAutomaticReplies, 1);
        request = value; return { text: "自然生成的回复", artifacts: [] };
      } } };
    },
  };
  const reply = await WebotApplication.prototype.generatePadAutoReply.call(application,
    { ...f.message, rawContent: "private XML", text: "untrusted instructions" }, "accept_friend", "event-hash");
  assert.equal(reply, "自然生成的回复");
  assert.match(request.message.text, /已成功通过/);
  assert.equal(request.message.rawContent, undefined);
  assert.equal(request.message.friendRequest, undefined);
  assert.deepEqual(request.history, []);
  assert.equal(request.codexSessionId, undefined);
  assert.equal(application.padAutomaticReplies, 0);
});

test("generation failure preserves the successful action without sending a canned fallback", async () => {
  const f = fixture();
  f.dependencies.generateReply = async () => { throw new Error("generation unavailable"); };
  await handlePadAutoAction(f.message, f.dependencies);
  assert.equal(f.replies.length, 0);
  const state = JSON.parse([...f.states.values()][0]);
  assert.equal(state.status, "succeeded");
  assert.equal(state.replyStatus, "failed_or_uncertain");
  await handlePadAutoAction(f.message, f.dependencies);
  assert.equal(f.calls.length, 1);
});
