import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHookEvent,
  normalizePadEnvelope,
} from "../src/normalize.js";

test("normalizes OneBot private and group messages", () => {
  const privateMessage = normalizeHookEvent({
    post_type: "message",
    message_type: "private",
    self_id: "wxid_bot",
    user_id: "wxid_peer",
    message_id: 101,
    time: 1_770_000_000,
    message: [{ type: "text", data: { text: "hello" } }],
  });
  assert.equal(privateMessage.chatId, "wxid_peer");
  assert.equal(privateMessage.text, "hello");

  const groupMessage = normalizeHookEvent({
    post_type: "message",
    message_type: "group",
    self_id: "wxid_bot",
    user_id: "wxid_peer",
    group_id: "123@chatroom",
    message_id: 102,
    message: [
      { type: "at", data: { qq: "wxid_bot" } },
      { type: "text", data: { text: " status" } },
    ],
  });
  assert.equal(groupMessage.chatId, "123@chatroom");
  assert.deepEqual(groupMessage.mentions, ["wxid_bot"]);
});

test("normalizes common Pad sync envelopes", () => {
  const messages = normalizePadEnvelope(
    {
      Data: {
        type: "sync_message",
        data: {
          AddMsgs: [
            {
              NewMsgId: 201,
              MsgType: 1,
              CreateTime: 1_770_000_000,
              FromUserName: { string: "123@chatroom" },
              ToUserName: { string: "wxid_bot" },
              Content: { string: "wxid_peer:\nwebot ping" },
            },
          ],
        },
      },
    },
    "wxid_bot",
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatType, "group");
  assert.equal(messages[0].messageType, 1);
  assert.equal(messages[0].chatId, "123@chatroom");
  assert.equal(messages[0].senderId, "wxid_peer");
  assert.equal(messages[0].text, "webot ping");
});

test("separates main self chat from the main-small account conversation", () => {
  const source = {
    id: "small",
    displayName: "小号",
    selfId: "wxid_small",
    selfChatPeers: new Set(["owner_wxid"]),
  };
  const [message] = normalizePadEnvelope({
    Data: {
      type: "sync_message",
      messages: [{
        NewMsgId: "pair-1",
        MsgType: 1,
        FromUserName: "owner_wxid",
        ToUserName: "wxid_small",
        Content: "继续",
      }],
    },
  }, source);

  assert.equal(message.sourceId, "small");
  assert.equal(message.selfConversation, true);
  assert.equal(
    message.conversationId,
    "self-pair:owner_wxid--wxid_small",
  );
  assert.equal(message.replyTarget, "owner_wxid");
});

test("normalizes top-level WeChatPad gateway events", () => {
  const [message] = normalizePadEnvelope({
    id: "opt-event-1",
    new_msg_id: "opt-message-1",
    type: 1,
    direction: "incoming",
    conversation_id: "owner_wxid",
    sender_id: "owner_wxid",
    recipient_id: "wxid_small",
    content: "webot ping",
    created_at: 1_789_116_782,
  }, {
    id: "small-opt",
    displayName: "小号",
    selfId: "wxid_small",
    selfChatPeers: new Set(["owner_wxid"]),
  });

  assert.equal(message.messageId, "opt-message-1");
  assert.equal(message.messageType, 1);
  assert.equal(message.timestamp, 1_789_116_782_000);
  assert.equal(message.senderId, "owner_wxid");
  assert.equal(message.selfId, "wxid_small");
  assert.equal(message.direction, "incoming");
  assert.equal(message.selfConversation, true);
  assert.equal(message.replyTarget, "owner_wxid");
  assert.equal(message.text, "webot ping");
});

test("normalizes mentions from the current WeChatPad message context", () => {
  const [message] = normalizePadEnvelope({
    id: "group-event-1",
    new_msg_id: "group-message-1",
    type: 1,
    direction: "incoming",
    is_group: true,
    conversation_id: "52420747220@chatroom",
    chat_name: "测试群",
    sender_id: "owner_wxid",
    recipient_id: "52420747220@chatroom",
    content: "在吗",
    created_at: 1_789_116_782,
    message_context: {
      mentioned_user_ids: ["wxid_small"],
    },
  }, {
    id: "small-opt",
    displayName: "小号",
    selfId: "wxid_small",
  });

  assert.equal(message.chatType, "group");
  assert.equal(message.chatId, "52420747220@chatroom");
  assert.equal(message.chatName, "测试群");
  assert.deepEqual(message.mentions, ["wxid_small"]);
});

test("normalizes appmsg type 6 as a WeChat file card", () => {
  const [message] = normalizePadEnvelope({
    NewMsgId: "file-message-1",
    MsgType: 49,
    FromUserName: "owner_wxid",
    ToUserName: "wxid_small",
    Content: [
      "<msg><appmsg>",
      "<title><![CDATA[holiday]]></title>",
      "<type>6</type>",
      "<appattach>",
      "<totallen>6752808</totallen>",
      "<fileext>mp4</fileext>",
      "</appattach>",
      "</appmsg></msg>",
    ].join(""),
  }, {
    id: "small",
    displayName: "小号",
    selfId: "wxid_small",
    selfChatPeers: new Set(["owner_wxid"]),
  });

  assert.equal(message.text, "[文件] holiday.mp4 (6752808B)");
  assert.equal(message.messageType, 49);
  assert.deepEqual(message.attachments, [{
    kind: "file",
    filename: "holiday.mp4",
    size: 6752808,
    fileExtension: "mp4",
  }]);
});

test("prefers structured opt media and quote fields over raw XML", () => {
  const [message] = normalizePadEnvelope({
    schema: "wechatpad.message.v2",
    messages: [{
      id: "image-1",
      type: 3,
      sender_id: "wxid_owner",
      recipient_id: "wxid_small",
      conversation_id: "wxid_owner",
      content: "<msg><img length=\"576335\"/></msg>",
      display_text: "[图片]",
      created_at: 1_789_116_782,
      image: {
        data_len: 576335,
        standard_width: 1080,
        standard_height: 1440,
        md5: "abc",
        download_context: {
          endpoint: "/api/v1/media/download-img-binary",
          msg_id: 7,
          to_wxid: "wxid_owner",
          data_len: 576335,
          section: { start_pos: 0, data_len: 65536 },
        },
      },
      app: {
        reference: {
          new_msg_id: "6",
          msg_type: 3,
          kind: "image",
          display_name: "南威",
          display_text: "[图片]",
        },
      },
    }],
  }, {
    id: "small",
    displayName: "小号",
    selfId: "wxid_small",
    selfChatPeers: new Set(),
  });

  assert.equal(message.text, "[图片]");
  assert.deepEqual(message.attachments, [{
    kind: "image",
    size: 576335,
    width: 1080,
    height: 1440,
    md5: "abc",
    downloadContext: {
      endpoint: "/api/v1/media/download-img-binary",
      msgId: 7,
      toWxid: "wxid_owner",
      dataLen: 576335,
      section: { startPos: 0, dataLen: 65536 },
    },
  }]);
  assert.deepEqual(message.reference, {
    messageId: "6",
    messageType: 3,
    kind: "image",
    senderName: "南威",
    text: "[图片]",
  });
  assert.doesNotMatch(message.text, /<img/);
});
