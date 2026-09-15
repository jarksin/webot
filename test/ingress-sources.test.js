import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("loads source-scoped Pad policies and credentials", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webot-sources-"));
  const configPath = path.join(directory, "sources.json");
  fs.writeFileSync(configPath, JSON.stringify({
    sources: [
      {
        id: "main",
        self_wxid: "owner_wxid",
        access_token_env: "MAIN_TOKEN",
        allow_self_chat: true,
        accept_self_chat_peer_messages: false,
        self_chat_peers: ["wxid_small"]
      },
      {
        id: "small",
        self_wxid: "wxid_small",
        access_token_env: "SMALL_TOKEN",
        accept_self_chat_peer_messages: true,
        ignore_allowlist: true,
        group_chat_ids: ["one@chatroom", "two@chatroom"],
        private_nickname_allowlist: ["家人"]
      }
    ]
  }));

  const config = loadConfig({
    WEBOT_PAD_SOURCES_FILE: configPath,
    MAIN_TOKEN: "main-secret",
    SMALL_TOKEN: "small-secret",
  });

  assert.equal(config.pad.sources.length, 2);
  assert.equal(config.pad.sources[0].accessToken, "main-secret");
  assert.equal(config.pad.sources[0].credentialSource, "environment");
  assert.equal(config.pad.sources[0].acceptSelfChatPeerMessages, false);
  assert.equal(config.pad.sources[0].ignoreAllowlist, false);
  assert.equal(config.pad.sources[1].acceptSelfChatPeerMessages, true);
  assert.equal(config.pad.sources[1].ignoreAllowlist, true);
  assert.deepEqual([...config.pad.sources[1].allowedChatIds], [
    "one@chatroom",
    "two@chatroom",
  ]);
  assert.deepEqual(
    [...config.pad.sources[1].privateNicknameAllowlist],
    ["家人"],
  );
});

test("does not reuse a legacy Pad token across source accounts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webot-sources-"));
  const configPath = path.join(directory, "sources.json");
  fs.writeFileSync(configPath, JSON.stringify({
    sources: [
      {
        id: "main",
        self_wxid: "wxid_main",
      },
      {
        id: "small",
        self_wxid: "wxid_small",
      },
    ],
  }));

  const config = loadConfig({
    WEBOT_SELF_WXID: "wxid_main",
    WEBOT_PAD_ACCESS_TOKEN: "main-only",
    WEBOT_PAD_SOURCES_FILE: configPath,
  });

  assert.equal(config.pad.sources[0].accessToken, "main-only");
  assert.equal(config.pad.sources[0].credentialSource, "legacy_default");
  assert.equal(config.pad.sources[1].accessToken, "");
  assert.equal(config.pad.sources[1].credentialSource, "");
});
