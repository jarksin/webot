import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizePadEnvelope } from "../src/normalize.js";
import { PadTransport } from "../src/transports/pad.js";
import { markHydratedFile, modelFiles } from "../src/inbound-files.js";

const movie = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex");
const rawMD5 = crypto.createHash("md5").update(movie).digest("hex");
const rawContext = {
  endpoint: "/api/v1/media/download-raw-video-binary",
  rawDataLen: movie.length, rawMD5, rawAESKey: "0123456789abcdef0123456789abcdef",
  cdnRawVideoFileNo: "synthetic-raw-video-id",
};
const scope = { sourceId: "source", messageId: "9007199254740993", chatId: "friend", transport: "pad" };

function transport(fetch) {
  return new PadTransport({ apiUrl: "http://pad.local/api", accessToken: "fixture-token",
    sources: [{ id: "source", apiUrl: "http://pad.local/api", accessToken: "fixture-token" }] },
  "live", console, fetch);
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-inbound-video-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("structured video chooses complete raw context without mixing compressed metadata", () => {
  function normalize(raw) {
    return normalizePadEnvelope({ schema: "wechatpad.message.v2", messages: [{
      id: scope.messageId, type: 43, sender_id: "friend", recipient_id: "self",
      conversation_id: "friend", display_text: "[video]",
      video: { data_len: 12, md5: "compressed-md5", download_context: {
        endpoint: "/api/v1/media/download-video-binary", msg_id: 7, data_len: 12,
      }, raw_download_context: raw },
    }] }, { id: "source", selfId: "self", selfChatPeers: new Set() })[0].attachments[0];
  }
  const raw = {
    endpoint: rawContext.endpoint, raw_data_len: movie.length, raw_md5: rawMD5,
    raw_aes_key: rawContext.rawAESKey, cdn_raw_video_file_no: rawContext.cdnRawVideoFileNo,
  };
  const attachment = normalize(raw);
  assert.equal(attachment.size, movie.length);
  assert.equal(attachment.md5, rawMD5);
  assert.deepEqual(attachment.downloadContext, rawContext);
  const incomplete = normalize({ ...raw, raw_aes_key: "" });
  assert.equal(incomplete.size, 12);
  assert.equal(incomplete.md5, "compressed-md5");
  assert.equal(incomplete.downloadContext.endpoint, "/api/v1/media/download-video-binary");
});

test("raw video caches only complete verified bytes and becomes an opaque file reference", async (t) => {
  const directory = await temporary(t);
  let calls = 0;
  const client = transport(async (url, options) => {
    calls += 1;
    assert.equal(url, "http://pad.local/api/v1/media/download-raw-video-binary");
    const body = JSON.parse(options.body).video.download_context;
    assert.equal(body.raw_data_len, movie.length);
    assert.equal(body.raw_aes_key, rawContext.rawAESKey);
    assert.equal(body.cdn_raw_video_file_no, rawContext.cdnRawVideoFileNo);
    assert.equal(body.raw_md5, rawMD5);
    assert.equal(body.msg_id, undefined);
    return new Response(movie);
  });
  const attachment = { kind: "video", size: movie.length, md5: rawMD5, downloadContext: rawContext };
  const first = await client.downloadInboundAttachment(scope, attachment, directory);
  const second = await client.downloadInboundAttachment(scope, attachment, directory);
  assert.equal(calls, 1);
  assert.equal(first.localPath, second.localPath);
  assert.equal(first.mime, "video/mp4");
  assert.deepEqual(await fs.readFile(first.localPath), movie);
  assert.equal((await fs.stat(first.localPath)).mode & 0o777, 0o600);
  const hydrated = await markHydratedFile(attachment, first);
  const files = modelFiles({ ...scope, attachments: [hydrated] });
  assert.equal(files.length, 1);
  assert.equal(files[0].readableAsText, false);
  assert.equal(files[0].mime, "video/mp4");
});

test("raw truncation and corruption fail without retry or compressed fallback", async (t) => {
  const directory = await temporary(t);
  for (const data of [movie.subarray(0, 12), Buffer.alloc(movie.length)]) {
    let calls = 0;
    const client = transport(async () => { calls += 1; return new Response(data); });
    await assert.rejects(client.downloadInboundAttachment(scope,
      { kind: "video", downloadContext: rawContext }, directory), /size or digest/);
    assert.equal(calls, 1);
  }
});

test("ordinary complete video preserves exact server ID and accepts authoritative server length", async (t) => {
  const directory = await temporary(t);
  const client = transport(async (_url, options) => {
    const context = JSON.parse(options.body).video.download_context;
    assert.equal(context.new_msg_id, scope.messageId);
    assert.equal(context.data_len, 12);
    return new Response(movie);
  });
  const result = await client.downloadInboundAttachment(scope, {
    kind: "video", md5: "non-authoritative-XML-md5",
    downloadContext: { endpoint: "/api/v1/media/download-video-binary",
      msgId: 7, newMsgId: scope.messageId, dataLen: 12 },
  }, directory);
  assert.equal(result.size, movie.length);
});

test("partial video endpoints and incomplete raw credentials never reach network", async (t) => {
  const directory = await temporary(t);
  const client = transport(async () => { assert.fail("invalid video context reached network"); });
  for (const context of [
    { ...rawContext, endpoint: "/api/v1/media/download-video" },
    { ...rawContext, rawAESKey: "" },
    { ...rawContext, rawDataLen: 100 * 1024 * 1024 + 1 },
  ]) {
    await assert.rejects(client.downloadInboundAttachment(scope,
      { kind: "video", downloadContext: context }, directory));
  }
});
