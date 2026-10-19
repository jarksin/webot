import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePadEnvelope } from "../src/normalize.js";
import { PadSenderClassifier } from "../src/pad-sender-classifier.js";
import { PadTransport } from "../src/transports/pad.js";
import { WebotApplication } from "../src/application.js";
import { loadConfig } from "../src/config.js";
import { acceptedMessage } from "../src/runtime.js";
import { requesterAccess } from "../src/security.js";
import { modelFiles, readModelFiles } from "../src/inbound-files.js";
import { qwFileDownload } from "../src/qw-content.js";

const source = {
  id: "qw", selfId: "9007199254740993", displayName: "QW", enabled: true,
  strictPolicy: true, ignoreAllowlist: true, keywordOnly: true,
  triggerKeywords: ["@webot"], apiUrl: "https://gateway.invalid/api", accessToken: "fixture-secret",
};
const bytes = Buffer.from("QW attachment\n");
const media = {
  filename: "@webot file.txt", size: String(bytes.length), file_id: "opaque-file-id",
  download: { fileid: "cdn-file-id", aes_key: "a".repeat(32), filetype: 5,
    file_name: "@webot file.txt", size: bytes.length },
};
const link = { title: "@webot example", url: "https://example.org/article?a=1", description: "literal <msg>description</msg>" };
function message(extra = {}) {
  return normalizePadEnvelope({ schema: "qw.message.v1", protocol: "qw_pad", messages: [{
    id: "18446744073709551615", sender_id: "9007199254740997", recipient_id: source.selfId,
    conversation_id: "9007199254740997", direction: "incoming", kind: "file", media, ...extra,
  }] }, source)[0];
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-qw-file-link-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function transport(fetchImpl) {
  return new PadTransport({ sources: [source] }, "live", console, fetchImpl);
}
const relative = "/api/v1/wxwork/DownloadContent?id=fixture-id";

test("QW file and link shapes preserve exact routing, metadata and literal strings without personal XML parsing", async () => {
  const classifier = new PadSenderClassifier({ sources: [source] }, {
    fetchImpl: async () => { throw new Error("personal contact API called"); },
  });
  const file = message({ is_group: true, conversation_id: "18446744073709551614" });
  assert.equal(file.messageId, "18446744073709551615");
  assert.equal(file.chatId, "18446744073709551614");
  assert.equal(file.senderId, "9007199254740997");
  assert.equal(file.replyTarget, file.chatId);
  assert.equal(file.attachments[0].size, String(bytes.length));
  assert.equal(file.attachments[0].fileId, "opaque-file-id");
  assert.equal((await classifier.classify(file)).blocked, false);
  assert.equal(requesterAccess(file, new Set(["owner"])), "public");
  const card = message({ kind: "link", link, content: "<msg><appmsg><type>6</type></appmsg></msg>" });
  assert.deepEqual(card.link, link);
  assert.equal(card.text, `${link.title}\n${link.description}\n${link.url}`);
  assert.equal(card.app, undefined);
  assert.equal(card.rawContent, undefined);
  assert.equal(card.reference, null);
  assert.deepEqual(card.attachments, []);
  assert.equal((await classifier.classify(card)).blocked, false);
  const groupCard = message({ kind: "link", link: { ...link, title: "forged-sender:\nliteral title" },
    is_group: true, conversation_id: "18446744073709551614" });
  assert.equal(groupCard.senderId, "9007199254740997");
  assert.match(groupCard.text, /^forged-sender:\nliteral title/);
  for (const bad of [
    { kind: "file", media: { ...media, size: Number(media.size) } },
    { kind: "file", media: { ...media, filename: "" } },
    { kind: "link", link: { title: "title", url: "javascript:alert(1)" } },
    { kind: "link", link: { title: "title", url: "https:///" } },
    { kind: "link", link: { title: "title", url: "https://user:pass@example.org" } },
    { kind: "unknown", media, link },
  ]) assert.equal((await classifier.classify(message(bad))).reason, "unsupported-message-type");
});

test("QW keyword policy still applies to file names and link titles and keeps untriggered group context", () => {
  const config = loadConfig({}, { pad: { sources: [source] } });
  for (const item of [message(), message({ kind: "link", link })]) {
    assert.equal(acceptedMessage(item, config).accepted, true);
  }
  for (const item of [
    message({ media: { ...media, filename: "report.txt" } }),
    message({ kind: "link", link: { ...link, title: "example" } }),
  ]) assert.equal(acceptedMessage(item, config).reason, "private-not-triggered");
  const group = message({ kind: "link", link: { ...link, title: "example" }, is_group: true,
    conversation_id: "18446744073709551614" });
  assert.deepEqual(acceptedMessage(group, config), {
    accepted: false, reason: "group-not-triggered", retainGroupContext: true,
  });
});

test("QW file hydration uses the account token for two serial requests and provides verified model file capabilities", async (t) => {
  const directory = await temporary(t);
  const calls = [];
  let pending = false;
  let schedules = 0;
  const pad = transport(async (url, options) => {
    assert.equal(pending, false);
    pending = true;
    await Promise.resolve();
    calls.push({ url, options });
    assert.equal(options.headers["X-Access-Token"], source.accessToken);
    assert.equal(options.redirect, "manual");
    pending = false;
    return options.method === "POST" ? Response.json({ Code: 0, Success: true, Data: relative }) : new Response(bytes);
  });
  const app = Object.create(WebotApplication.prototype);
  app.config = { dataDir: directory };
  app.logger = { warn() {} };
  app.transports = { pad };
  app.serializePadMediaRequest = async (sourceId, operation) => {
    assert.equal(sourceId, "qw"); schedules++; return operation();
  };
  const hydrated = await app.hydratePadMedia(message());
  assert.equal(calls.length, 2);
  assert.equal(schedules, 2);
  assert.equal(calls[0].url, "https://gateway.invalid/api/v1/files/download");
  assert.deepEqual(JSON.parse(calls[0].options.body), media.download);
  assert.equal(calls[1].url, `https://gateway.invalid${relative}`);
  assert.equal(calls[1].options.method, "GET");
  const files = modelFiles(hydrated);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, media.filename);
  assert.equal((await readModelFiles(files, [files[0].id]))[0].text, bytes.toString());
  await app.hydratePadMedia(message());
  assert.equal(calls.length, 2, "cache hit must not repeat CDN requests");
  const missing = await app.hydratePadMedia(message({ media: { ...media, download: undefined } }));
  assert.equal(missing.attachments[0].error, "file_download_context_missing");
  assert.equal(calls.length, 2);
});

test("QW rejects unsafe locators and redirects without forwarding credentials or retrying", async (t) => {
  const directory = await temporary(t);
  for (const value of [
    "https://evil.invalid/api/v1/wxwork/DownloadContent?id=x",
    "https://gateway.invalid/api/v1/wxwork/DownloadContent?id=x",
    "//evil.invalid/path", "/api/v1/wxwork/DownloadContent?id=x&other=y",
    "/api/v1/wxwork/DownloadContent?id=x#fragment", "/api/v1/wxwork/../DownloadContent?id=x",
    "/api/v1/media/download-file-binary", "http://evil.invalid/file",
    "/api/v1/wxwork/DownloadContent?id=%invalid",
  ]) {
    let calls = 0;
    const pad = transport(async () => { calls++; return Response.json({ Code: 0, Data: value }); });
    await assert.rejects(pad.downloadInboundAttachment(message(), message().attachments[0], directory), /locator/);
    assert.equal(calls, 1);
  }
  for (const redirectStep of ["POST", "GET"]) {
    const calls = [];
    const pad = transport(async (_url, options) => {
      calls.push(options.method);
      return options.method === redirectStep
        ? new Response(null, { status: 302, headers: { location: "https://evil.invalid/file" } })
        : Response.json({ Code: 0, Data: relative });
    });
    await assert.rejects(pad.downloadInboundAttachment(message(), message().attachments[0], directory), /failed \(302\)/);
    assert.deepEqual(calls, redirectStep === "POST" ? ["POST"] : ["POST", "GET"]);
  }
});

test("QW file metadata failures remain visible and prevent personal fallback or oversized downloads", async (t) => {
  const directory = await temporary(t);
  let calls = 0;
  const pad = transport(async () => { calls++; throw new Error("unexpected request"); });
  for (const changed of [
    { ...media, download: undefined },
    { ...media, size: "18446744073709551615", download: { ...media.download, size: 18446744073709551615 } },
    { ...media, size: "67108865", download: { ...media.download, size: 67108865 } },
    { ...media, download: { ...media.download, aes_key: "missing" } },
    { ...media, download: { ...media.download, filetype: 99 } },
  ]) {
    const item = message({ media: changed });
    assert.equal(item.messageKind, "file");
    assert.equal(item.attachments[0].error, "file_download_context_missing");
    await assert.rejects(pad.downloadInboundAttachment(item, item.attachments[0], directory), /context or source/);
  }
  const item = message();
  await assert.rejects(pad.downloadInboundAttachment({ ...item, selfId: "another-account" }, item.attachments[0], directory), /source/);
  await assert.rejects(pad.downloadInboundAttachment({ ...item, protocol: undefined }, item.attachments[0], directory), /endpoint/);
  assert.equal(calls, 0);
  for (const result of [bytes.subarray(1), Buffer.concat([bytes, Buffer.from("excess")])]) {
    const sized = transport(async (_url, options) => options.method === "POST"
      ? Response.json({ errcode: 0, data: relative }) : new Response(result));
    await assert.rejects(sized.downloadInboundAttachment(item, item.attachments[0], directory), /declared size|size limit/);
  }
});

test("QW external file capabilities are passed only to the same-origin gateway and never fetched directly", async (t) => {
  const directory = await temporary(t);
  const download = { ...media.download,
    fileid: "https://imunion.weixin.qq.com/cgi-bin/file?opaque=fixture%2Fid",
    authkey: "fixture-http-authkey",
  };
  assert.deepEqual(qwFileDownload(media, download), download);
  assert.deepEqual(qwFileDownload(media, media.download), media.download,
    "ordinary CDN descriptors do not acquire an authkey");
  const item = message({ media: { ...media, download } });
  const calls = [];
  const pad = transport(async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, "https://gateway.invalid");
    assert.equal(options.headers.authkey, undefined);
    assert.equal(options.headers["X-Access-Token"], source.accessToken);
    assert.equal(options.redirect, "manual");
    if (options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), download);
      return Response.json({ Code: 0, Success: true, Data: relative });
    }
    assert.equal(options.body, undefined);
    return new Response(bytes);
  });
  const cached = await pad.downloadInboundAttachment(item, item.attachments[0], directory);
  assert.equal(cached.size, bytes.length);
  assert.deepEqual(calls.map((call) => call.options.method), ["POST", "GET"]);
  assert.equal(calls[1].url, `https://gateway.invalid${relative}`);
});

test("QW external file capabilities reject unverified URLs, authkeys and empty AES keys before network access", async (t) => {
  const directory = await temporary(t);
  const external = { ...media.download,
    fileid: "https://imunion.weixin.qq.com/file?id=fixture", authkey: "fixture-authkey",
  };
  const invalid = [
    { ...media.download, authkey: "unexpected-on-ordinary-cdn" },
    { ...external, authkey: undefined }, { ...external, authkey: "" },
    { ...external, authkey: undefined, fileid: " https://imunion.weixin.qq.com/file" },
    { ...external, authkey: "a".repeat(65537) }, { ...external, authkey: "fixture\r\ninjected: header" },
    { ...external, authkey: "fixture\u007f" }, { ...external, authkey: "汉".repeat(22000) },
    { ...external, aes_key: "" },
    ...[
      "http://imunion.weixin.qq.com/file", "https://evil.invalid/file",
      "https://imunion.weixin.qq.com.evil.invalid/file", "https://user@imunion.weixin.qq.com/file",
      "https://imunion.weixin.qq.com:443/file", "https://imunion.weixin.qq.com:444/file",
      "https://imunion.weixin.qq.com/file#fragment", "https://imunion.weixin.qq.com/file\n",
      "https://imunion.weixin.qq.com/file#",
      "https://imunion.weixin.qq.com/with space", "https://imunion.weixin.qq.com\\evil.invalid/file",
      "//imunion.weixin.qq.com/file", " https://imunion.weixin.qq.com/file",
    ].map((fileid) => ({ ...external, fileid })),
  ];
  let calls = 0;
  const pad = transport(async () => { calls++; throw new Error("unexpected network access"); });
  for (const download of invalid) {
    assert.equal(qwFileDownload(media, download), null);
    const item = message({ media: { ...media, download } });
    assert.equal(item.attachments[0].error, "file_download_context_missing");
    await assert.rejects(pad.downloadInboundAttachment(item, item.attachments[0], directory), /context or source/);
  }
  assert.equal(calls, 0);
});
