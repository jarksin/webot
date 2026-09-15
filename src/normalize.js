function scalar(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object") {
    return scalar(
      value.string ??
        value.String ??
        value.value ??
        value.Value ??
        value.str ??
        value.id,
    );
  }
  return "";
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlTag(xml, tag) {
  const match = String(xml || "").match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return match ? decodeXmlText(match[1]).trim() : "";
}

function padContent(message, rawContent) {
  const messageType = Number(
    scalar(message.MsgType ?? message.msg_type ?? message.type),
  );
  if (messageType !== 49 || !/<appmsg(?:\s|>)/i.test(rawContent)) {
    return { text: rawContent, attachments: [] };
  }
  const appType = Number(xmlTag(rawContent, "type"));
  if (appType !== 6) return { text: rawContent, attachments: [] };
  const extension = xmlTag(rawContent, "fileext").replace(/^\./, "");
  let filename = xmlTag(rawContent, "title") || "微信文件";
  if (extension && !filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    filename = `${filename}.${extension}`;
  }
  const size = Number(xmlTag(rawContent, "totallen")) || 0;
  return {
    text: `[文件] ${filename}${size ? ` (${size}B)` : ""}`,
    attachments: [{
      kind: "file",
      filename,
      size,
      fileExtension: extension,
    }],
  };
}

function timestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return number < 10_000_000_000 ? number * 1000 : number;
}

function oneBotContent(message) {
  if (typeof message === "string") return { text: message, mentions: [] };
  const segments = Array.isArray(message) ? message : [];
  const texts = [];
  const mentions = [];

  for (const segment of segments) {
    const type = segment?.type;
    const data = segment?.data || {};
    if (type === "text") texts.push(scalar(data.text));
    if (type === "at") {
      const id = scalar(data.qq ?? data.user_id ?? data.wxid);
      if (id) mentions.push(id);
    }
  }

  return { text: texts.join("").trim(), mentions };
}

export function normalizeHookEvent(event) {
  if (!event || event.post_type !== "message") return null;
  if (!["private", "group"].includes(event.message_type)) return null;

  const content = oneBotContent(event.message ?? event.raw_message);
  const senderId = scalar(event.user_id ?? event.sender?.user_id);
  const groupId = scalar(event.group_id);

  return {
    transport: "hook",
    messageId: scalar(event.message_id) || `${event.time || Date.now()}`,
    timestamp: timestampMs(event.time),
    chatType: event.message_type,
    chatId: event.message_type === "group" ? groupId : senderId,
    senderId,
    senderName: scalar(
      event.sender?.card ?? event.sender?.nickname ?? event.sender?.name,
    ),
    selfId: scalar(event.self_id),
    text: content.text,
    mentions: content.mentions,
  };
}

function collectPadMessages(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectPadMessages(item, output, seen);
    return output;
  }

  for (const key of ["AddMsgs", "add_msgs", "messages", "Messages"]) {
    if (Array.isArray(value[key])) {
      collectPadMessages(value[key], output, seen);
    }
  }

  const hasMessageShape =
    value.MsgType != null ||
    value.msg_type != null ||
    value.NewMsgId != null ||
    value.new_msg_id != null ||
    value.newMsgId != null ||
    value.message_id != null ||
    (
      value.id != null &&
      (
        value.sender_id != null ||
        value.recipient_id != null ||
        value.content != null
      )
    );
  if (hasMessageShape) output.push(value);

  for (const key of ["Data", "data", "payload", "Payload", "message"]) {
    if (value[key] && typeof value[key] === "object") {
      collectPadMessages(value[key], output, seen);
    }
  }
  return output;
}

function splitPadGroupContent(content) {
  const match = content.match(/^([^:\s]+):\s*\n([\s\S]*)$/);
  if (!match) return { embeddedSender: "", text: content };
  return { embeddedSender: match[1], text: match[2] };
}

function padPushSenderName(value) {
  const text = scalar(value).trim();
  const match = text.match(/^([^:：\s][^:：]{0,80})[:：]/);
  return match ? match[1].trim() : text;
}

function pairKey(first, second) {
  return [first, second]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("--");
}

function padMentionIds(message) {
  const contexts = [
    message.message_context,
    message.MessageContext,
    message.MsgSource,
    message.msg_source,
    message.GoFields?.MsgSource,
    message.go_fields?.msg_source,
  ].filter((value) => value && typeof value === "object");
  const values = [
    message.AtUserList,
    message.at_user_list,
    ...contexts.flatMap((context) => [
      context.MentionedUserIDs,
      context.mentioned_user_ids,
      context.AtUserList,
      context.at_user_list,
    ]),
  ];
  return [
    ...new Set(
      values
        .flatMap((value) => Array.isArray(value) ? value : [])
        .map(scalar)
        .filter(Boolean),
    ),
  ];
}

function normalizePadMessage(message, sourceValue) {
  const source =
    typeof sourceValue === "string"
      ? { id: "default", displayName: "default", selfId: sourceValue }
      : sourceValue || { id: "default", displayName: "default", selfId: "" };
  const selfId = scalar(source.selfId);
  const from = scalar(
    message.FromUserName ??
      message.from_user_name ??
      message.from_wxid ??
      message.sender_id,
  );
  const to = scalar(
    message.ToUserName ??
      message.to_user_name ??
      message.to_wxid ??
      message.recipient_id,
  );
  const isGroup = Boolean(
    message.is_group === true ||
      message.is_group === 1 ||
      /^(1|true|yes)$/i.test(scalar(message.is_group)),
  );
  const room = scalar(
    message.ChatRoomName ??
      message.chat_room_name ??
      message.room_id ??
      (isGroup ? message.conversation_id : undefined) ??
      (from.endsWith("@chatroom") ? from : ""),
  );
  const chatName = scalar(
    message.ChatRoomNickName ??
      message.chat_room_nickname ??
      message.ChatRoomDisplayName ??
      message.chat_room_display_name ??
      message.ChatName ??
      message.chat_name ??
      message.room_name ??
      message.conversation_name,
  );
  const rawContent = scalar(
    message.Content ?? message.content ?? message.text ?? message.Text,
  );
  const content = padContent(message, rawContent);
  const split = room
    ? splitPadGroupContent(content.text)
    : { embeddedSender: "", text: content.text };
  const actualSender = scalar(
    message.ActualUserName ??
      message.actual_user_name ??
      message.actual_sender ??
      message.Source?.ActualSender ??
      split.embeddedSender,
  );
  const senderId = room ? actualSender || from : from;
  const senderName = scalar(
    message.ActualNickName ??
      message.actual_nickname ??
      message.FromNick ??
      message.fromNick,
  ) || padPushSenderName(message.PushContent ?? message.pushContent)
    || scalar(message.sender_name);
  const direction =
    scalar(message.direction ?? message.Direction).toLowerCase() ||
    (selfId && from === selfId ? "outgoing" : "") ||
    (selfId && to === selfId ? "incoming" : "") ||
    "unknown";
  const peerId = room ? room : senderId === selfId ? to : senderId;
  const exactSelfChat = Boolean(!room && selfId && from === selfId && to === selfId);
  const selfPeer = Boolean(
    !room &&
      peerId &&
      [...(source.selfChatPeers || [])].some(
        (candidate) =>
          String(candidate).toLowerCase() === String(peerId).toLowerCase(),
      ),
  );
  const selfConversation = exactSelfChat || selfPeer;
  const conversationId = room
    ? `group:${source.id}:${room}`
    : exactSelfChat
      ? `self:${selfId}`
      : selfPeer
        ? `self-pair:${pairKey(selfId, peerId)}`
        : `private:${source.id}:${peerId}`;

  return {
    transport: "pad",
    sourceId: source.id,
    sourceName: source.displayName,
    messageId:
      scalar(
        message.NewMsgId ??
          message.new_msg_id ??
          message.newMsgId ??
          message.MsgId ??
          message.message_id ??
          message.id,
      ) || `${message.CreateTime || Date.now()}:${senderId}`,
    timestamp: timestampMs(
      message.CreateTime ??
        message.create_time ??
        message.timestamp ??
        message.created_at,
    ),
    chatType: room ? "group" : "private",
    chatId: room || peerId,
    chatName,
    conversationId,
    senderId,
    senderName,
    selfId: selfId || (to && !to.endsWith("@chatroom") ? to : ""),
    direction,
    selfConversation,
    selfPeer,
    exactSelfChat,
    replyTarget: room || peerId,
    text: split.text.trim(),
    attachments: content.attachments,
    mentions: padMentionIds(message),
  };
}

export function normalizePadEnvelope(envelope, source = "") {
  return collectPadMessages(envelope).map((message) =>
    normalizePadMessage(message, source),
  );
}
