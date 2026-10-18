import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const XIANYU_MAX_AGE_MS = 5 * 60_000;
export const XIANYU_MAX_FUTURE_MS = 30_000;
// Local bridge admission limits, not limits inferred from the native protocol.
export const XIANYU_MAX_INCOMING_UNITS = 8000;
export const XIANYU_MAX_OUTGOING_UNITS = 4000;

export function xianyuStableId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9._:@-]{1,160}$/.test(value);
}

export function loadXianyuSources(env, values = []) {
  if (!Array.isArray(values)) throw new Error("invalid Xianyu sources");
  const ids = new Set();
  return values.map((value) => {
    if (!value || !/^[A-Za-z0-9._-]{1,160}$/.test(value.id || "")) {
      throw new Error("invalid Xianyu source id");
    }
    if (ids.has(value.id.toLowerCase())) {
      throw new Error("duplicate Xianyu source id");
    }
    ids.add(value.id.toLowerCase());
    if (!xianyuStableId(value.accountId)) throw new Error("invalid Xianyu account id");
    let url;
    try { url = new URL(value.bridgeUrl); } catch {
      throw new Error("invalid Xianyu bridge URL");
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/"
    ) {
      throw new Error("Xianyu bridge URL must be an HTTPS origin or loopback HTTP origin");
    }
    if (value.secret) {
      throw new Error("Xianyu secret must use secretEnv or secretFile");
    }
    const secretEnv = String(value.secretEnv || "").trim();
    const configuredFile = String(value.secretFile || "").trim();
    const secretFile = configuredFile
      ? path.resolve(configuredFile.startsWith("~/")
        ? path.join(os.homedir(), configuredFile.slice(2))
        : configuredFile)
      : "";
    if (secretEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) {
      throw new Error("invalid Xianyu secret environment variable");
    }
    let secret = String((secretEnv && env[secretEnv]) || "").trim();
    let credentialSource = secret ? "environment" : "";
    if (!secret && secretFile) {
      try {
        const stat = fs.lstatSync(secretFile);
        if (!stat.isFile() || (stat.mode & 0o077) ||
          (process.getuid && stat.uid !== process.getuid())) {
          throw new Error("unprotected file");
        }
        secret = fs.readFileSync(secretFile, "utf8").trim();
        credentialSource = secret ? "file" : "";
      } catch {
        throw new Error("Xianyu secret file must be an owned, private regular file");
      }
    }
    if (!secret) throw new Error("Xianyu source requires a nonempty secret");
    return {
      id: value.id,
      enabled: value.enabled === true,
      bridgeUrl: url.origin,
      accountId: value.accountId,
      secret,
      secretEnv,
      secretFile,
      credentialSource,
    };
  });
}

export function xianyuSourceForMessage(config, message) {
  return (config.xianyu?.sources || []).find(
    (source) => source.id === message?.sourceId,
  ) || null;
}

function namespace(source, ...parts) {
  return ["xianyu", source.id, source.accountId, ...parts]
    .map(encodeURIComponent).join(":");
}

export function normalizeXianyuEvent(event, source, now = Date.now()) {
  const keys = [
    "messageId", "chatId", "senderId", "accountId", "text",
    "timestamp", "direction", "type",
  ];
  if (
    !event || typeof event !== "object" || Array.isArray(event) ||
    Object.keys(event).some((key) => !keys.includes(key)) ||
    !["messageId", "chatId", "senderId", "accountId"].every(
      (key) => xianyuStableId(event[key]),
    ) ||
    event.accountId !== source.accountId ||
    event.direction !== "incoming" || event.type !== "text" ||
    event.senderId.toLowerCase() === source.accountId.toLowerCase() ||
    /^(system|notification|service)$/i.test(event.senderId) ||
    typeof event.text !== "string" || !event.text.trim() ||
    event.text.length > XIANYU_MAX_INCOMING_UNITS ||
    !Number.isSafeInteger(event.timestamp) ||
    event.timestamp < now - XIANYU_MAX_AGE_MS ||
    event.timestamp > now + XIANYU_MAX_FUTURE_MS
  ) {
    throw new Error("invalid or expired Xianyu event");
  }
  return {
    transport: "xianyu",
    sourceId: source.id,
    sourceName: source.id,
    messageType: 1,
    messageId: namespace(source, "message", event.chatId, event.messageId),
    timestamp: event.timestamp,
    chatType: "private",
    chatId: namespace(source, "chat", event.chatId),
    conversationId: namespace(source, "chat", event.chatId),
    senderId: namespace(source, "user", event.senderId),
    selfId: namespace(source, "user", source.accountId),
    direction: "incoming",
    selfConversation: false,
    text: event.text,
    mentions: [],
    attachments: [],
    xianyu: {
      accountId: source.accountId,
      chatId: event.chatId,
      senderId: event.senderId,
      messageId: event.messageId,
    },
  };
}

export function xianyuMessageDecision(config, message) {
  if (!config.channels.has("xianyu")) {
    return { accepted: false, reason: "channel-disabled" };
  }
  const source = xianyuSourceForMessage(config, message);
  if (!source) return { accepted: false, reason: "source-not-configured" };
  if (!source.enabled || !source.secret) {
    return { accepted: false, reason: "source-disabled" };
  }
  try {
    const expected = normalizeXianyuEvent({
      ...message.xianyu,
      text: message.text,
      timestamp: message.timestamp,
      direction: message.direction,
      type: message.messageType === 1 ? "text" : "",
    }, source);
    if (["senderId", "selfId", "messageId", "chatId", "conversationId", "chatType"]
      .some((key) => message[key] !== expected[key]) ||
      message.selfConversation || message.exactSelfChat || message.selfPeer ||
      message.attachments?.length) {
      return { accepted: false, reason: "invalid-xianyu-message" };
    }
  } catch {
    return { accepted: false, reason: "invalid-xianyu-message" };
  }
  if (config.policy.blockedSenderIds.has(message.senderId)) {
    return { accepted: false, reason: "blocked" };
  }
  return { accepted: true, text: message.text };
}
