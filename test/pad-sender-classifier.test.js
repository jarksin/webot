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

test("blocks internal lastMessage status events in any conversation", async () => {
  let requests = 0;
  const classifier = new PadSenderClassifier(config(), {
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected request");
    },
  });

  const result = await classifier.classify({
    transport: "pad",
    sourceId: "small",
    chatType: "group",
    chatId: "project@chatroom",
    senderId: "wxid_small",
    text: "<msg><op id='2'><name>lastMessage</name></op></msg>",
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, "internal-status-message");
  assert.equal(requests, 0);
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
