import test from "node:test";
import assert from "node:assert/strict";
import { directoryEntriesFromContacts } from "../src/contact-directory.js";

test("projects contact list identities for users, groups, and official accounts", () => {
  const entries = directoryEntriesFromContacts({
    Data: {
      ContactList: [
        {
          UserName: { string: "wxid_friend" },
          Remark: { string: "同事" },
          NickName: { string: "朋友昵称" },
          Alias: "friend_alias",
        },
        {
          UserName: "123@chatroom",
          NickName: "项目群",
        },
        {
          UserName: "service-account",
          NickName: "服务号",
          VerifyFlag: 8,
        },
      ],
    },
  }, "small");

  assert.deepEqual(entries.map((entry) => ({
    entityType: entry.entityType,
    entityId: entry.entityId,
    displayName: entry.displayName,
  })), [
    {
      entityType: "user",
      entityId: "wxid_friend",
      displayName: "同事",
    },
    {
      entityType: "group",
      entityId: "123@chatroom",
      displayName: "项目群",
    },
    {
      entityType: "official",
      entityId: "service-account",
      displayName: "服务号",
    },
  ]);
  assert.deepEqual(entries[0].searchNames, [
    "同事",
    "朋友昵称",
    "friend_alias",
  ]);
});
