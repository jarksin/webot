import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HookTransport } from "../src/transports/hook.js";
import {
  cleanPadMentionDisplayName,
  formatPadReplyText,
  formatPadMentionText,
  PadTransport,
  PadWebSocketClient,
} from "../src/transports/pad.js";

function replaceWebSocket(context, replacement) {
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: replacement,
  });
  context.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: original,
    });
  });
}

test("Hook transport uses OneBot private and group endpoints", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ status: "ok", retcode: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const transport = new HookTransport(
    { apiUrl: "http://hook.local", accessToken: "" },
    "live",
  );

  await transport.send(
    { chatType: "private", chatId: "wxid_peer" },
    "private reply",
  );
  await transport.send(
    { chatType: "group", chatId: "room@chatroom" },
    "group reply",
  );

  assert.equal(calls[0].url, "http://hook.local/send_private_msg");
  assert.equal(calls[0].body.user_id, "wxid_peer");
  assert.equal(calls[1].url, "http://hook.local/send_group_msg");
  assert.equal(calls[1].body.group_id, "room@chatroom");
});

test("Pad transport sends the expected text contract", async (context) => {
  let call;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    call = {
      url,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({ BaseResponse: { Ret: 0 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const transport = new PadTransport(
    {
      apiUrl: "http://pad.local",
      accessToken: "test-token",
      requireWriteConfirmation: true,
    },
    "live",
  );

  await transport.send(
    { chatType: "private", chatId: "wxid_peer" },
    "pad reply",
  );

  assert.equal(call.url, "http://pad.local/v1/messages/send-text");
  assert.equal(call.headers["X-Access-Token"], "test-token");
  assert.equal(call.body.to, "wxid_peer");
  assert.equal(call.body.content, "pad reply");
  assert.equal(call.body.type, 1);
  assert.equal(call.body.confirm, true);
  assert.match(call.body.request_id, /^[0-9a-f-]{36}$/);
});

test("Pad transport mentions the triggering sender in group replies", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ Code: 0 });
  });
  const transport = new PadTransport(
    {
      apiUrl: "http://pad.local",
      accessToken: "test-token",
      requireWriteConfirmation: true,
      selfId: "wxid_bot",
    },
    "live",
    console,
    globalThis.fetch,
    {
      resolveMentionDisplayName: (message) =>
        message.senderId === "wxid_member" ? "群成员甲" : "",
    },
  );

  await transport.send({
    chatType: "group",
    chatId: "room@chatroom",
    senderId: "wxid_member",
  }, "group reply");
  await transport.send({
    chatType: "group",
    chatId: "room@chatroom",
    senderId: "wxid_bot",
  }, "self reply");

  assert.equal(calls[0].body.to, "room@chatroom");
  assert.equal(calls[0].body.content, "@群成员甲\u2005 group reply");
  assert.equal(calls[0].body.at, "wxid_member");
  assert.equal(calls[1].body.content, "self reply");
  assert.equal(calls[1].body.at, "");
});

test("Pad mention labels prefer safe sender names and never expose raw IDs", () => {
  assert.equal(
    formatPadMentionText("group reply", "晴耕雨读", "wxid_member"),
    "@晴耕雨读\u2005 group reply",
  );
  assert.equal(
    formatPadMentionText("@晴耕雨读\u2005 group reply", "晴耕雨读", "wxid_member"),
    "@晴耕雨读\u2005 group reply",
  );
  assert.equal(
    formatPadMentionText("group reply", "wxid_member", "wxid_member"),
    "@微信用户\u2005 group reply",
  );
  assert.equal(
    cleanPadMentionDisplayName("wxid_member", "wxid_member"),
    "",
  );
});

test("Pad transport sends images, audio, and generic file cards", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-files-"));
  const image = path.join(directory, "cover.png");
  const audioFile = path.join(directory, "audio-file.mp3");
  const voice = path.join(directory, "voice.mp3");
  const video = path.join(directory, "clip.mp4");
  await fs.writeFile(image, "image-bytes");
  await fs.writeFile(audioFile, "audio-file-bytes");
  await fs.writeFile(voice, "voice-bytes");
  await fs.writeFile(video, "video-bytes");
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ Code: 0 });
  });
  const transport = new PadTransport({
    apiUrl: "http://pad.local/api",
    accessToken: "test-token",
    requireWriteConfirmation: true,
  }, "live");
  const target = {
    chatType: "private",
    chatId: "wxid_peer",
    replyTarget: "wxid_peer",
  };

  await transport.sendArtifact(target, { path: image, kind: "image" });
  await transport.sendArtifact(target, {
    path: audioFile,
    filename: "audio-file.mp3",
    kind: "file",
    mime: "audio/mpeg",
  });
  await transport.sendArtifact(target, {
    path: voice,
    filename: "voice.mp3",
    kind: "audio",
    mime: "audio/mpeg",
    durationMs: 12_345,
  });
  await transport.sendArtifact(target, {
    path: video,
    filename: "holiday.mp4",
    kind: "file",
    mime: "video/mp4",
  });

  assert.equal(calls[0].url, "http://pad.local/api/v1/messages/send-image");
  assert.equal(calls[0].body.to, "wxid_peer");
  assert.equal(calls[1].url, "http://pad.local/api/v1/messages/send-file");
  assert.equal(calls[1].body.FileName, "audio-file.mp3");
  assert.equal(
    Buffer.from(calls[1].body.Base64, "base64").toString(),
    "audio-file-bytes",
  );
  assert.equal(calls[2].url, "http://pad.local/api/v1/messages/send-voice");
  assert.equal(calls[2].body.duration_ms, 12_345);
  assert.equal(calls[2].body.format, 2);
  assert.equal(
    Buffer.from(calls[2].body.data_base64, "base64").toString(),
    "voice-bytes",
  );
  assert.equal(calls[3].url, "http://pad.local/api/v1/messages/send-file");
  assert.equal(calls[3].body.FileName, "holiday.mp4");
  assert.equal(
    Buffer.from(calls[3].body.Base64, "base64").toString(),
    "video-bytes",
  );
  assert.equal(calls[3].body.confirm, true);
});

test("Pad transport reports a missing file-card capability", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-files-"));
  const file = path.join(directory, "report.pdf");
  await fs.writeFile(file, "report");
  context.mock.method(globalThis, "fetch", async () =>
    new Response("404 page not found", { status: 404 })
  );
  const transport = new PadTransport({
    apiUrl: "http://pad.local/api",
    accessToken: "test-token",
    requireWriteConfirmation: true,
  }, "live");

  await assert.rejects(
    transport.sendArtifact(
      { chatId: "wxid_peer" },
      { path: file, mime: "application/pdf" },
    ),
    /does not expose WeChat file-card delivery/,
  );
});

test("Pad transport identifies oversized attachments for text fallback", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-files-"));
  const file = path.join(directory, "oversized.tar.gz");
  await fs.writeFile(file, Buffer.alloc(1));
  await fs.truncate(file, 64 * 1024 * 1024 + 1);
  const transport = new PadTransport({
    apiUrl: "http://pad.local/api",
    accessToken: "test-token",
    requireWriteConfirmation: true,
  }, "live");

  await assert.rejects(
    transport.sendArtifact(
      { chatId: "wxid_peer" },
      { path: file, mime: "application/gzip" },
    ),
    (error) =>
      error.code === "WEBOT_ATTACHMENT_TOO_LARGE" &&
      error.filePath === file &&
      error.fileSize === 64 * 1024 * 1024 + 1,
  );
});

test("Pad transport caches a complete inbound image from its structured context", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-inbound-"));
  const png = Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
    Buffer.from("fixture"),
  ]);
  let call;
  const transport = new PadTransport({
    apiUrl: "http://pad.local/api",
    accessToken: "test-token",
    sources: [{
      id: "small",
      apiUrl: "http://pad.local/api",
      accessToken: "test-token",
    }],
  }, "live", console, async (url, options) => {
    call = {
      url,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(png, {
      status: 200,
      headers: { "Content-Length": String(png.length) },
    });
  });

  const result = await transport.downloadInboundAttachment({
    sourceId: "small",
    messageId: "image:1",
  }, {
    kind: "image",
    downloadContext: {
      endpoint: "/api/v1/media/download-img-binary",
      msgId: 7,
      dataLen: png.length,
      section: { dataLen: 65536 },
    },
  }, directory);

  assert.equal(call.url, "http://pad.local/api/v1/media/download-img-binary");
  assert.equal(call.headers["X-Access-Token"], "test-token");
  assert.deepEqual(call.body.image.download_context, {
    msg_id: 7,
    data_len: png.length,
    section: { start_pos: 0, data_len: 65536 },
  });
  assert.equal(result.mime, "image/png");
  assert.equal(result.filename, "image_1.png");
  assert.deepEqual(await fs.readFile(result.localPath), png);
});

test("Pad transport rejects uppercase API failures", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { Success: false, Code: -2, Message: "发送失败" },
      { status: 200 },
    ),
  );
  const transport = new PadTransport(
    {
      apiUrl: "http://pad.local",
      accessToken: "test-token",
      requireWriteConfirmation: false,
    },
    "live",
  );

  await assert.rejects(
    transport.send(
      { chatType: "private", chatId: "wxid_peer" },
      "pad reply",
    ),
    /Pad send failed/,
  );
});

test("Pad transport replies through the originating source account", async (context) => {
  let call;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    call = {
      url,
      headers: options.headers,
      body: JSON.parse(options.body),
    };
    return new Response(JSON.stringify({ BaseResponse: { Ret: 0 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const transport = new PadTransport({
    requireWriteConfirmation: false,
    sources: [{
      id: "small",
      apiUrl: "http://small.local",
      accessToken: "small-token",
      selfId: "wxid_small",
      strictPolicy: true,
    }],
  }, "live");

  await transport.send({
    sourceId: "small",
    chatType: "private",
    chatId: "owner_wxid",
    replyTarget: "owner_wxid",
  }, "收到");

  assert.equal(call.url, "http://small.local/v1/messages/send-text");
  assert.equal(call.headers["X-Access-Token"], "small-token");
  assert.equal(call.body.to, "owner_wxid");
  assert.equal(call.body.content, "收到");
});

test("Pad transport keeps the AI marker only for same-account self replies", () => {
  const source = {
    id: "main",
    selfId: "owner_wxid",
    strictPolicy: true,
  };

  assert.equal(
    formatPadReplyText(
      "收到",
      {
        chatType: "private",
        replyTarget: "owner_wxid",
      },
      source,
    ),
    "【AI】收到",
  );
  assert.equal(
    formatPadReplyText(
      "【AI】跨账号回复",
      {
        chatType: "private",
        replyTarget: "wxid_small",
      },
      source,
    ),
    "跨账号回复",
  );
  assert.equal(
    formatPadReplyText(
      "【AI 1/2】群回复",
      {
        chatType: "group",
        replyTarget: "room@chatroom",
      },
      source,
    ),
    "群回复",
  );
  assert.equal(
    formatPadReplyText(
      "【AI】旧模式原文",
      {
        chatType: "private",
        replyTarget: "wxid_peer",
      },
      {
        selfId: "wxid_bot",
        strictPolicy: false,
      },
    ),
    "【AI】旧模式原文",
  );
});

test("Pad WebSocket error does not recursively close the failing socket", (context) => {
  class FakeWebSocket extends EventTarget {
    static instances = [];

    constructor(url) {
      super();
      this.url = String(url);
      this.closeCalls = 0;
      this.readyState = 0;
      FakeWebSocket.instances.push(this);
    }

    close() {
      this.closeCalls += 1;
      this.dispatchEvent(new Event("error"));
    }
  }

  replaceWebSocket(context, FakeWebSocket);
  const client = new PadWebSocketClient(
    {
      id: "small-opt",
      selfId: "wxid_small",
      wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
      accessToken: "test-token",
    },
    "wxid_small",
    async () => {},
    { info() {}, warn() {}, error() {} },
  );

  client.start();
  const socket = FakeWebSocket.instances[0];
  socket.dispatchEvent(new Event("error"));

  assert.equal(client.status().lastError, "websocket error");
  assert.equal(client.status().connectionState, "reconnecting");
  assert.ok(client.timer);
  assert.equal(client.socket, null);
  assert.equal(socket.closeCalls, 0);
  client.stop();
  assert.equal(socket.closeCalls, 0);
});

test("Pad WebSocket ignores stale socket events after reconnect", (context) => {
  class FakeWebSocket extends EventTarget {
    static instances = [];

    constructor() {
      super();
      FakeWebSocket.instances.push(this);
    }

    close() {}
  }

  replaceWebSocket(context, FakeWebSocket);
  const client = new PadWebSocketClient(
    {
      id: "small-opt",
      selfId: "wxid_small",
      wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
      accessToken: "test-token",
    },
    "wxid_small",
    async () => {},
    { info() {}, warn() {}, error() {} },
  );

  client.start();
  const oldSocket = FakeWebSocket.instances[0];
  oldSocket.dispatchEvent(new Event("close"));
  clearTimeout(client.timer);
  client.timer = null;
  client.connect();
  const currentSocket = FakeWebSocket.instances[1];
  currentSocket.dispatchEvent(new Event("open"));
  oldSocket.dispatchEvent(new Event("close"));

  assert.equal(client.socket, currentSocket);
  assert.equal(client.status().connected, true);
  client.stop();
});

test("Pad WebSocket retries a connection that never finishes opening", async (context) => {
  class FakeWebSocket extends EventTarget {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      FakeWebSocket.instances.push(this);
    }

    close() {}
  }

  replaceWebSocket(context, FakeWebSocket);
  const client = new PadWebSocketClient(
    {
      id: "small-opt",
      selfId: "wxid_small",
      wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
      accessToken: "test-token",
      websocketConnectTimeoutMs: 1_000,
    },
    "wxid_small",
    async () => {},
    { info() {}, warn() {}, error() {} },
  );

  client.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_050));

  assert.equal(client.socket, null);
  assert.equal(client.status().connectionState, "reconnecting");
  assert.match(client.status().lastError, /timed out after 1000ms/);
  assert.ok(client.timer);
  client.stop();
});

test("Pad WebSocket closes an open socket during a clean stop", (context) => {
  class FakeWebSocket extends EventTarget {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.closeCalls = 0;
      FakeWebSocket.instances.push(this);
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    }
  }

  replaceWebSocket(context, FakeWebSocket);
  const client = new PadWebSocketClient(
    {
      id: "small-opt",
      selfId: "wxid_small",
      wsUrl: "ws://127.0.0.1:18102/ws/wxid_small",
      accessToken: "test-token",
    },
    "wxid_small",
    async () => {},
    { info() {}, warn() {}, error() {} },
  );

  client.start();
  const socket = FakeWebSocket.instances[0];
  socket.readyState = 1;
  socket.dispatchEvent(new Event("open"));
  client.stop();

  assert.equal(socket.closeCalls, 1);
  assert.equal(client.status().connectionState, "stopped");
});
