import test from "node:test";
import assert from "node:assert/strict";
import {
  directoryContactCursor,
  directoryContactIds,
  directoryEntriesFromContacts,
  isDirectoryContactId,
} from "../src/contact-directory.js";

test("projects contact identities for users and groups while excluding services", () => {
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
  ]);
  assert.deepEqual(entries[0].searchNames, [
    "同事",
    "朋友昵称",
    "friend_alias",
  ]);
});

test("extracts contact list ids and continuation cursors", () => {
  const body = {
    Data: {
      ContactUsernameList: [
        { string: "wxid_friend" },
        "123@chatroom",
        "wxid_friend",
      ],
      CountinueFlag: 1,
      CurrentWxcontactSeq: 12,
      CurrentChatRoomContactSeq: 34,
    },
  };
  assert.deepEqual(directoryContactIds(body), [
    "wxid_friend",
    "123@chatroom",
  ]);
  assert.deepEqual(directoryContactCursor(body), {
    continue: true,
    wxContactSeq: 12,
    chatRoomSeq: 34,
  });
  assert.equal(isDirectoryContactId("wxid_friend"), true);
  assert.equal(isDirectoryContactId("123@chatroom"), true);
  assert.equal(isDirectoryContactId("gh_service"), false);
  assert.equal(isDirectoryContactId("newsapp"), false);
});
