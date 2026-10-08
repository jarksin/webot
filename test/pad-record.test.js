import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePadEnvelope, padRecordMessage } from "../src/normalize.js";
import { PadTransport } from "../src/transports/pad.js";
import { markHydratedFile, modelFiles, readModelFiles } from "../src/inbound-files.js";

const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const digest = crypto.createHash("md5").update(image).digest("hex");
const record = {
  kind: "note",
  title: "sample",
  items: [
    { data_id: "text", data_type: 1, text: "full body", sender_name: "A" },
    {
      data_id: "photo", data_type: 2, format: "jpg", data_len: image.length, md5: digest,
      download_context: {
        endpoint: "/api/v1/media/download-record-binary", file_type: 1,
        cdn_file_no: "fixture", data_len: image.length, aes_key: "0".repeat(32), md5: digest,
      },
    },
    { data_id: "html", data_type: 8, title: "note.htm", format: "htm", data_len: 3 },
  ],
};
const source = { id: "test", selfId: "bot", apiUrl: "http://pad.local/api", accessToken: "fixture-token" };
const rawMessage = {
  id: "record-1", type: 49, sender_id: "peer", recipient_id: "bot",
  content: "<msg><appmsg><type>24</type><recorditem>private XML retained</recorditem></appmsg></msg>",
  display_text: "[share] https://invalid.example/upgrade",
  app: { category: "24", url: "https://invalid.example/upgrade", description: "summary only" },
};

test("Pad records retain body/order and never treat the upgrade URL as content", () => {
  const [message] = normalizePadEnvelope({ ...rawMessage, app: { ...rawMessage.app, record } }, source);
  assert.match(message.text, /\[笔记\] sample\nA: full body\n\[图片 2\]\n\[文件\] note.htm/);
  assert.doesNotMatch(message.text, /upgrade|summary only/);
  assert.equal(message.rawContent, rawMessage.content);
  assert.deepEqual(message.attachments.map((item) => [item.kind, item.recordDataId]), [
    ["image", "photo"], ["file", "html"],
  ]);
  assert.equal(message.attachments[0].downloadContext.fileType, 1);
  const [legacy] = normalizePadEnvelope(rawMessage, source);
  assert.match(legacy.text, /\[笔记\]/);
  assert.doesNotMatch(legacy.text, /upgrade/);
});

test("Pad record parsing uses its source API and serialized request hook", async () => {
  const calls = [];
  let requests = 0;
  const transport = new PadTransport(source, "live", console, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), token: options.headers["X-Access-Token"] });
    return Response.json({ Code: 0, Success: true, Data: { record, display_text: "[笔记]\nfull body" } });
  });
  const [message] = normalizePadEnvelope(rawMessage, source);
  const parsed = await transport.parseInboundRecord(message, { request: async (fn) => { requests++; return fn(); } });
  assert.equal(requests, 1);
  assert.equal(calls[0].url, "http://pad.local/api/v1/messages/parse-record");
  assert.equal(calls[0].body.content, message.rawContent);
  assert.equal(calls[0].token, "fixture-token");
  assert.equal(parsed.app.url, "");
  assert.equal(parsed.attachments.length, 2);
  await transport.parseInboundRecord(parsed);
  assert.equal(calls.length, 1);
});

test("Pad record images verify native context, length and MD5, then reuse cache", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-record-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  const transport = new PadTransport(source, "live", console, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(image);
  });
  const [legacy] = normalizePadEnvelope(rawMessage, source);
  const message = padRecordMessage(legacy, record);
  const attachment = message.attachments[0];
  const first = await transport.downloadInboundAttachment(message, attachment, directory);
  const second = await transport.downloadInboundAttachment(message, attachment, directory);
  assert.equal(first.mime, "image/jpeg");
  assert.equal(first.localPath, second.localPath);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://pad.local/api/v1/media/download-record-binary");
  assert.equal(calls[0].body.record_item.download_context.file_type, 1);
  await assert.rejects(transport.downloadInboundAttachment(message, {
    ...attachment, md5: "f".repeat(32),
  }, directory), /does not match/);
  await assert.rejects(transport.downloadInboundAttachment(message, {
    ...attachment, downloadContext: { ...attachment.downloadContext, fileType: 999 },
  }, directory), /missing or invalid/);
  assert.equal(calls.length, 1);
});

test("Pad record download errors never cache corrupted bytes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-record-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const transport = new PadTransport(source, "live", console, async () => new Response(Buffer.alloc(image.length)));
  const [legacy] = normalizePadEnvelope(rawMessage, source);
  const message = padRecordMessage(legacy, record);
  await assert.rejects(transport.downloadInboundAttachment(message, message.attachments[0], directory), /digest/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("note HTM attachments use the existing controlled file-read capability", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-record-html-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const localPath = path.join(directory, "note.htm");
  const body = "<html><body>complete note</body></html>";
  await fs.writeFile(localPath, body);
  const attachment = await markHydratedFile(
    { kind: "file", filename: "note.htm" },
    { localPath, filename: "note.htm", size: Buffer.byteLength(body), mime: "application/octet-stream" },
  );
  const files = modelFiles({ messageId: "record-1", attachments: [attachment] });
  assert.equal(files[0].readableAsText, true);
  const results = await readModelFiles(files, [files[0].id]);
  assert.equal(results[0].text, body);
});
