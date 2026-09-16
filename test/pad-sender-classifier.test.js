import test from "node:test";
import assert from "node:assert/strict";
import { PadSenderClassifier } from "../src/pad-sender-classifier.js";

function config(ignoreAllowlist = true) {
  return {
    sources: [{
      id: "small",
      selfId: "wxid_small",
      apiUrl: "http://127.0.0.1:18102/api",
      accessToken: "secret",
      ignoreAllowlist,
    }],
  };
}

function message(senderId) {
  return {
    transport: "pad",
    sourceId: "small",
    messageType: 1,
    chatType: "private",
    chatId: senderId,
    senderId,
  };
}

test("blocks known system and gh_ accounts without a contact lookup", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected request");
    },
  });

  assert.equal((await classifier.classify(message("newsapp"))).blocked, true);
  assert.equal(
    (await classifier.classify(message("wxid_novlwrv3lqwv11"))).blocked,
    true,
  );
  assert.equal(
    (await classifier.classify(message("gh_example"))).blocked,
    true,
  );
  assert.equal(
    (await classifier.classify({
      ...message("wxid_small"),
      chatId: "filehelper",
      direction: "outgoing",
    })).blocked,
    true,
  );
  assert.equal(requests, 0);
});

test("blocks internal Pad status events in any conversation", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected request");
    },
  });

  const lastMessage = await classifier.classify({
    transport: "pad",
    sourceId: "small",
    messageType: 51,
    chatType: "group",
    chatId: "project@chatroom",
    senderId: "wxid_small",
    text: "<msg><op id='5'><name>lastMessage</name></op></msg>",
  });
  const handoff = await classifier.classify({
    transport: "pad",
    sourceId: "small",
    messageType: 51,
    chatType: "private",
    chatId: "wxid_small",
    senderId: "wxid_small",
    text: "<msg><op id='11'><name>HandOffMaster</name></op></msg>",
  });
  const download = await classifier.classify({
    transport: "pad",
    sourceId: "small",
    messageType: 51,
    chatType: "private",
    chatId: "wxid_small",
    senderId: "wxid_small",
    text: [
      "<msg><op id='11'><name>DownloadFile</name><arg><![CDATA[",
      "<downloadList><downloadItem><username>room@chatroom</username>",
      "</downloadItem></downloadList>]]></arg></op></msg>",
    ].join(""),
  });
  const quotedXml = await classifier.classify({
    transport: "pad",
    sourceId: "small",
    messageType: 1,
    chatType: "group",
    chatId: "project@chatroom",
    senderId: "wxid_person",
    text: "please inspect <msg><op id='11'><name>DownloadFile</name></op></msg>",
  });

  assert.equal(lastMessage.blocked, true);
  assert.equal(lastMessage.reason, "internal-status-message");
  assert.equal(handoff.blocked, true);
  assert.equal(handoff.reason, "internal-status-message");
  assert.equal(download.blocked, true);
  assert.equal(download.reason, "internal-status-message");
  assert.equal(quotedXml.blocked, false);
  assert.equal(requests, 0);
});

test("allows only configured regular Pad message types", async () => {
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      throw new Error("unexpected request");
    },
  });
  const base = {
    transport: "pad",
    sourceId: "small",
    chatType: "group",
    chatId: "project@chatroom",
    senderId: "wxid_person",
    text: "content",
  };

  for (const messageType of [1, 3, 34, 37, 42, 43, 47, 48, 49, 62]) {
    assert.equal(
      (await classifier.classify({ ...base, messageType })).blocked,
      false,
    );
  }
  for (const messageType of [51, 10000, 10002, null]) {
    const result = await classifier.classify({ ...base, messageType });
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "unsupported-message-type");
  }
});

test("blocks WeChat safety notices without blocking the contact", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        async json() {
          return {
            Success: true,
            Data: {
              ContactList: [{
                UserName: "wxid_contact",
                VerifyFlag: 0,
              }],
            },
          };
        },
      };
    },
  });
  const notice = await classifier.classify({
    ...message("wxid_contact"),
    text:
      '对方账号安全性未知，如涉及金钱交易务必电话确认，保护个人财产和隐私安全。<a href="weixin://expose/">我要投诉</a>',
  });
  const ordinary = await classifier.classify({
    ...message("wxid_contact"),
    text: "正常消息",
  });

  assert.equal(notice.blocked, true);
  assert.equal(notice.reason, "wechat-safety-notice");
  assert.equal(ordinary.blocked, false);
  assert.equal(requests, 1);
});

test("uses VerifyFlag to block non-gh official accounts and caches results", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: true,
        async json() {
          return {
            Success: true,
            Data: {
              ContactList: [{
                UserName: { string: "wxid_official" },
                VerifyFlag: 24,
              }],
            },
          };
        },
      };
    },
  });

  assert.equal(
    (await classifier.classify(message("wxid_official"))).reason,
    "verified-official-account",
  );
  assert.equal(
    (await classifier.classify(message("wxid_official"))).blocked,
    true,
  );
  assert.equal(requests, 1);
});

test("allows verified personal contacts and fails closed on lookup errors", async () => {
  const personal = new PadSenderClassifier(config(), {
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          Success: true,
          Data: {
            ContactList: [{
              UserName: "wxid_person",
              VerifyFlag: 0,
            }],
          },
        };
      },
    }),
  });
  assert.equal(
    (await personal.classify(message("wxid_person"))).blocked,
    false,
  );

  const unavailable = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    logger: { warn() {} },
  });
  assert.equal(
    (await unavailable.classify(message("wxid_unknown"))).reason,
    "sender-classification-unavailable",
  );
});

test("does not query contact details when allowlist bypass is disabled", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(false), {
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected request");
    },
  });

  assert.equal(
    (await classifier.classify(message("wxid_person"))).blocked,
    false,
  );
  assert.equal(requests, 0);
});

test("does not make owner self conversations depend on contact lookup", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected request");
    },
  });

  assert.equal(
    (await classifier.classify({
      ...message("owner_wxid"),
      selfConversation: true,
      selfPeer: true,
    })).blocked,
    false,
  );
  assert.equal(requests, 0);
});
