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

export function padFileCDNDownloadContext(rawContent, context = {}) {
  const xml = String(rawContent || "");
  if (
    !xml || xml.length > 128 * 1024 || xmlTag(xml, "type") !== "6" ||
    xmlTag(xml, "attachid") !== String(context.attachId || "") ||
    Number(xmlTag(xml, "totallen")) !== Number(context.dataLen)
  ) return context;
  const cdnAttachFileNo = xmlTag(xml, "cdnattachurl");
  const aesKey = xmlTag(xml, "aeskey");
  const md5 = xmlTag(xml, "md5");
  if (!cdnAttachFileNo && !aesKey) return context;
  return { ...context, cdnAttachFileNo, aesKey, md5 };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function padAppMetadata(message) {
  return objectValue(message.app ?? message.App);
}

function numberValue(value) {
  const number = Number(scalar(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function padDownloadContext(value) {
  const context = objectValue(value);
  if (!context) return null;
  const section = objectValue(context.section ?? context.Section);
  const result = {
    endpoint: scalar(context.endpoint ?? context.Endpoint),
    msgId: numberValue(context.msg_id ?? context.MsgID ?? context.msgId),
    newMsgId: scalar(
      context.new_msg_id ?? context.NewMsgID ?? context.newMsgId,
    ),
    clientMsgId: scalar(
      context.client_msg_id ?? context.ClientMsgID ?? context.clientMsgId,
    ),
    masterBufferId: scalar(
      context.master_buf_id ??
        context.MasterBufferID ??
        context.masterBufferId,
    ),
    toWxid: scalar(context.to_wxid ?? context.ToWXID ?? context.toWxid),
    chatRoomName: scalar(
      context.chat_room_name ??
        context.ChatRoomName ??
        context.chatRoomName,
    ),
    attachId: scalar(
      context.attach_id ?? context.AttachID ?? context.attachId,
    ),
    appId: scalar(context.app_id ?? context.AppID ?? context.appId),
    userName: scalar(
      context.user_name ?? context.UserName ?? context.userName,
    ),
    dataLen: numberValue(context.data_len ?? context.DataLen ?? context.dataLen),
    length: numberValue(context.length ?? context.Length),
    format: numberValue(context.format ?? context.Format),
    compressType: numberValue(
      context.compress_type ?? context.CompressType ?? context.compressType,
    ),
    rawDataLen: numberValue(context.raw_data_len ?? context.RawDataLen ?? context.rawDataLen),
    rawMD5: scalar(context.raw_md5 ?? context.RawMD5 ?? context.rawMD5),
    rawAESKey: scalar(context.raw_aes_key ?? context.RawAESKey ?? context.rawAESKey),
    cdnAttachFileNo: scalar(
      context.cdn_attach_file_no ?? context.CDNAttachFileNo ?? context.cdnAttachFileNo,
    ),
    aesKey: scalar(context.aes_key ?? context.AESKey ?? context.aesKey),
    md5: scalar(context.md5 ?? context.MD5),
    dataId: scalar(context.data_id ?? context.DataID ?? context.dataId),
    fileType: numberValue(context.file_type ?? context.FileType ?? context.fileType),
    cdnFileNo: scalar(context.cdn_file_no ?? context.CDNFileID ?? context.cdnFileNo),
    cdnRawVideoFileNo: scalar(
      context.cdn_raw_video_file_no ?? context.CDNRawVideoFileNo ?? context.cdnRawVideoFileNo,
    ),
    section: section
      ? {
          startPos: numberValue(
            section.start_pos ?? section.StartPos ?? section.startPos,
          ),
          dataLen: numberValue(
            section.data_len ?? section.DataLen ?? section.dataLen,
          ),
        }
      : null,
  };
  if (!result.endpoint) return null;
  return Object.fromEntries(
    Object.entries(result).filter(([, item]) =>
      item != null && item !== "" && item !== 0
    ),
  );
}

function padReference(message) {
  const reference = objectValue(
    message.app?.reference ??
      message.App?.Reference ??
      message.reference ??
      message.Reference,
  );
  if (!reference) return null;
  const result = {
    messageId: scalar(
      reference.new_msg_id ??
        reference.NewMsgID ??
        reference.svr_id ??
        reference.SvrID,
    ),
    messageType: numberValue(
      reference.msg_type ?? reference.MsgType ?? reference.messageType,
    ),
    kind: scalar(reference.kind ?? reference.Kind),
    senderId: scalar(
      reference.from_user_id ??
        reference.FromUserID ??
        reference.senderId,
    ),
    senderName: scalar(
      reference.display_name ??
        reference.DisplayName ??
        reference.senderName,
    ),
    text: scalar(
      reference.display_text ??
        reference.DisplayText ??
        reference.content ??
        reference.Content,
    ),
    attachments: structuredPadAttachments(reference),
    rawContent: scalar(
      reference.raw_content ??
        reference.rawContent ??
        reference.raw_xml ??
        reference.RawContent,
    ),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, item]) =>
      item != null && item !== "" && item !== 0 &&
      !(Array.isArray(item) && item.length === 0)
    ),
  );
}

function structuredPadAttachments(message) {
  const attachments = [];
  const record = padAppMetadata(message)?.record;
  if (record) attachments.push(...padRecordAttachments(record));
  const image = objectValue(message.image ?? message.Image);
  if (image) {
    attachments.push({
      kind: "image",
      size: numberValue(image.data_len ?? image.DataLen),
      width: numberValue(
        image.standard_width ??
          image.StandardWidth ??
          image.original_width ??
          image.OriginalWidth,
      ),
      height: numberValue(
        image.standard_height ??
          image.StandardHeight ??
          image.original_height ??
          image.OriginalHeight,
      ),
      md5: scalar(image.md5 ?? image.MD5),
      downloadContext: padDownloadContext(
        image.download_context ?? image.DownloadContext,
      ),
    });
  }
  const voice = objectValue(message.voice ?? message.Voice);
  if (voice) {
    attachments.push({
      kind: "audio",
      size: numberValue(voice.data_length ?? voice.DataLength),
      durationMs: numberValue(voice.duration_ms ?? voice.DurationMS),
      format: numberValue(voice.format ?? voice.Format),
      transcript: scalar(voice.transcript ?? voice.Transcript),
      downloadContext: padDownloadContext(
        voice.download_context ?? voice.DownloadContext,
      ),
    });
  }
  const video = objectValue(message.video ?? message.Video);
  if (video) {
    const rawContext = padDownloadContext(video.raw_download_context ?? video.RawDownloadContext);
    const completeRaw = rawContext?.endpoint === "/api/v1/media/download-raw-video-binary" &&
      rawContext.rawDataLen && rawContext.rawMD5 && rawContext.rawAESKey && rawContext.cdnRawVideoFileNo;
    attachments.push({
      kind: "video",
      size: completeRaw ? rawContext.rawDataLen : numberValue(video.data_len ?? video.DataLen),
      durationSeconds: numberValue(
        video.duration_seconds ?? video.DurationSeconds,
      ),
      md5: completeRaw ? rawContext.rawMD5 : scalar(video.md5 ?? video.MD5),
      downloadContext: completeRaw ? rawContext : padDownloadContext(
        video.download_context ?? video.DownloadContext,
      ),
    });
  }
  const file = objectValue(message.file ?? message.File);
  if (file) {
    let filename = scalar(file.name ?? file.Name) || "微信文件";
    const extension = scalar(file.extension ?? file.Extension).replace(/^\./, "");
    if (
      extension &&
      !filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ) {
      filename = `${filename}.${extension}`;
    }
    const downloadContext = padDownloadContext(
      file.download_context ?? file.DownloadContext,
    );
    if (downloadContext) {
      for (const [key, value] of [
        ["cdnAttachFileNo", scalar(file.cdn_attach_file_no ?? file.CDNAttachFileNo)],
        ["aesKey", scalar(file.aes_key ?? file.AESKey)],
        ["md5", scalar(file.md5 ?? file.MD5)],
      ]) {
        if (value && !downloadContext[key]) downloadContext[key] = value;
      }
    }
    attachments.push({
      kind: "file",
      filename,
      size: numberValue(file.data_len ?? file.DataLen),
      fileExtension: extension,
      md5: scalar(file.md5 ?? file.MD5),
      downloadContext,
    });
  }
  return attachments.map((attachment) =>
    Object.fromEntries(
      Object.entries(attachment).filter(([, item]) =>
        item != null && item !== "" && item !== 0
      ),
    )
  );
}

export function padRecordAttachments(record, depth = 0) {
  if (!record || depth >= 16 || !Array.isArray(record.items)) return [];
  return record.items.flatMap((item, index) => {
    const type = numberValue(item.data_type);
    const nested = padRecordAttachments(item.record, depth + 1);
    if (type !== 2 && type !== 8) return nested;
    const format = scalar(item.format).replace(/^\./, "");
    let filename = scalar(item.title) || `record-${index + 1}`;
    if (/^[a-z0-9]{1,12}$/i.test(format) &&
      !filename.toLowerCase().endsWith(`.${format.toLowerCase()}`)) filename += `.${format}`;
    return [{
      kind: type === 2 ? "image" : "file",
      filename,
      size: numberValue(item.data_len),
      md5: scalar(item.md5),
      recordDataId: scalar(item.data_id),
      downloadContext: padDownloadContext(item.download_context),
    }, ...nested];
  });
}

export function padRecordText(record, depth = 0) {
  if (!record || depth >= 16 || !Array.isArray(record.items)) return "";
  const prefix = record.kind === "note" ? "[笔记]" : "[聊天记录]";
  const lines = [`${prefix} ${scalar(record.title)}`.trim()];
  for (const [index, item] of record.items.entries()) {
    const type = numberValue(item.data_type);
    let text = type === 1 ? scalar(item.text || item.title) :
      type === 2 ? `[图片 ${index + 1}]` :
      type === 8 ? `[文件] ${scalar(item.title)}` :
      `[条目类型 ${type}] ${scalar(item.title)} ${scalar(item.text)}`.trim();
    if (item.sender_name) text = `${scalar(item.sender_name)}: ${text}`;
    if (text.trim()) lines.push(text);
    const nested = padRecordText(item.record, depth + 1);
    if (nested) lines.push(nested);
  }
  if (!record.items.length && record.description) lines.push(scalar(record.description));
  return lines.join("\n");
}

export function padRecordMessage(message, record, displayText = "") {
  return {
    ...message,
    text: displayText || padRecordText(record),
    app: { ...message.app, url: "", record },
    attachments: padRecordAttachments(record),
  };
}

function padContent(message, rawContent) {
  const app = padAppMetadata(message);
  if (["19", "24"].includes(String(app?.category))) {
    if (app.record) return { text: padRecordText(app.record), attachments: structuredPadAttachments(message) };
    const label = app.category === "24" ? "[笔记]" : "[聊天记录]";
    return {
      text: `${label} ${scalar(app.title)}\n${scalar(app.description)}`.trim(),
      attachments: [],
    };
  }
  const structuredText = scalar(
    message.display_text ?? message.DisplayText ?? message.displayText,
  ).trim();
  const structuredAttachments = structuredPadAttachments(message);
  if (structuredText || structuredAttachments.length) {
    return {
      text: structuredText || rawContent,
      attachments: structuredAttachments,
    };
  }
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

function normalizeTelegramAttachment(item) {
  if (!item || typeof item !== "object") return null;
  const downloadContext = item.download_context ?? item.downloadContext;
  const result = {
    kind: scalar(item.kind).toLowerCase() || "file",
    filename: scalar(item.filename),
    size: numberValue(item.size),
    mime: scalar(item.mime),
    downloadContext: downloadContext && typeof downloadContext === "object"
      ? {
          type: scalar(downloadContext.type),
          chatId: scalar(downloadContext.chat_id ?? downloadContext.chatId),
          messageId: numberValue(downloadContext.message_id ?? downloadContext.messageId),
        }
      : null,
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) =>
      value != null && value !== "" && value !== 0 &&
      !(typeof value === "object" && !Object.keys(value).length)
    ),
  );
}

function normalizeTelegramReference(value) {
  if (!value || typeof value !== "object") return null;
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(normalizeTelegramAttachment).filter(Boolean)
    : [];
  const result = {
    messageId: scalar(value.message_id ?? value.messageId),
    telegramMessageId: numberValue(
      value.telegram_message_id ?? value.telegramMessageId ?? value.message_id,
    ),
    senderId: scalar(value.sender_id ?? value.senderId),
    senderName: scalar(value.sender_name ?? value.senderName),
    text: scalar(value.text).trim(),
    attachments,
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, item]) =>
      item != null && item !== "" && item !== 0 &&
      !(Array.isArray(item) && item.length === 0)
    ),
  );
}

export function normalizeTelegramBridgeEvent(event, source = {}) {
  if (!event || event.type !== "message") return null;
  const messageId = scalar(event.message_id);
  const chatId = scalar(event.chat_id);
  const senderId = scalar(event.sender_id);
  const selfId = scalar(event.self_id);
  const attachments = Array.isArray(event.attachments)
    ? event.attachments.map(normalizeTelegramAttachment).filter(Boolean)
    : [];
  const text = scalar(event.text).trim() || (
    attachments.some((item) => item.kind === "image") ? "[图片]" : ""
  );
  if (!messageId || !chatId || !senderId || !text) return null;
  const chatType = event.chat_type === "group" ? "group" : "private";
  const reference = normalizeTelegramReference(event.reference);
  return {
    transport: "telegram",
    sourceId: String(source.id || "telegram"),
    sourceName: String(source.displayName || source.id || "Telegram"),
    messageId: `telegram:${messageId}`,
    telegramMessageId: numberValue(event.telegram_message_id),
    timestamp: timestampMs(event.timestamp),
    direction: event.direction === "outgoing" ? "outgoing" : "incoming",
    chatType,
    chatId,
    chatName: scalar(event.chat_name),
    senderId,
    senderName: scalar(event.sender_name),
    selfId,
    text,
    attachments,
    ...(reference ? { reference } : {}),
    mentions: Array.isArray(event.mentions)
      ? event.mentions.map(scalar).filter(Boolean)
      : [],
    selfConversation: Boolean(event.self_conversation),
    exactSelfChat: Boolean(event.exact_self_chat),
    selfPeer: false,
    replyTarget: scalar(event.reply_target) || chatId,
    conversationId: `${chatType}:${chatId}`,
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
  const messageType = Number(
    scalar(message.MsgType ?? message.msg_type ?? message.type),
  );
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
  const app = padAppMetadata(message);
  const preservedRawContent =
    rawContent &&
      (messageType === 49 || app || content.text !== rawContent)
      ? rawContent
      : "";
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
    messageType: Number.isInteger(messageType) ? messageType : null,
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
    ...(preservedRawContent ? { rawContent: preservedRawContent } : {}),
    ...(app ? { app } : {}),
    attachments: content.attachments,
    reference: padReference(message),
    mentions: padMentionIds(message),
  };
}

export function normalizePadEnvelope(envelope, source = "") {
  return collectPadMessages(envelope).map((message) =>
    normalizePadMessage(message, source),
  );
}
