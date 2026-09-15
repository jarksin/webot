import { sourceForMessage } from "./ingress-sources.js";

const DEFAULT_SYSTEM_ACCOUNT_IDS = new Set([
  "weixin",
  "fmessage",
  "newsapp",
  "filehelper",
  "floatbottle",
  "medianote",
  "mphelper",
  "wxid_novlwrv3lqwv11",
]);

function scalar(value) {
  if (value && typeof value === "object") {
    return value.str ?? value.string ?? value.value ?? "";
  }
  return value ?? "";
}

function contactList(body) {
  const data = body?.Data ?? body?.data ?? body?.response ?? body;
  const contacts =
    data?.ContactList ??
    data?.contactList ??
    data?.contacts ??
    body?.ContactList ??
    body?.contactList;
  if (Array.isArray(contacts)) return contacts;
  return data && typeof data === "object" ? [data] : [];
}

function contactUserName(contact) {
  return String(
    scalar(
      contact?.UserName ??
        contact?.userName ??
        contact?.username ??
        contact?.wxid,
    ),
  ).trim();
}

function isVerifiedOfficialAccount(contact) {
  const verifyFlag = Number(
    scalar(
      contact?.VerifyFlag ??
        contact?.verifyFlag ??
        contact?.verify_flag,
    ),
  );
  return Number.isFinite(verifyFlag) && (verifyFlag & 8) !== 0;
}

export function isPadSystemAccountId(value) {
  const id = String(value || "").trim().toLowerCase();
  return Boolean(
    id &&
      !id.includes("@chatroom") &&
      (id.startsWith("gh_") || DEFAULT_SYSTEM_ACCOUNT_IDS.has(id)),
  );
}

function isPadInternalStatusMessage(message) {
  const text = String(message?.text || "");
  return (
    /<op\b/i.test(text) &&
    /<name>\s*(?:lastMessage|HandOffMaster)\s*<\/name>/i.test(text)
  );
}

export class PadSenderClassifier {
  constructor(
    config,
    {
      fetchImpl = globalThis.fetch,
      logger = console,
      cacheTtlMs = 24 * 60 * 60 * 1000,
      maxCacheEntries = 4096,
    } = {},
  ) {
    this.config = config;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.cacheTtlMs = cacheTtlMs;
    this.maxCacheEntries = maxCacheEntries;
    this.cache = new Map();
  }

  cacheKey(source, senderId) {
    return `${source.id}:${String(senderId).trim().toLowerCase()}`;
  }

  cached(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  remember(key, value) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    while (this.cache.size > this.maxCacheEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  async classify(message) {
    if (message?.transport !== "pad") {
      return { blocked: false };
    }
    if (isPadInternalStatusMessage(message)) {
      return { blocked: true, reason: "internal-status-message" };
    }
    if (
      message.chatType === "private" &&
      (
        isPadSystemAccountId(message.senderId) ||
        isPadSystemAccountId(message.chatId)
      )
    ) {
      return { blocked: true, reason: "system-or-official-account" };
    }
    if (message.chatType !== "private") return { blocked: false };
    if (message.selfConversation || message.selfPeer || message.exactSelfChat) {
      return { blocked: false };
    }

    const source = sourceForMessage({ pad: this.config }, message);
    if (!source?.ignoreAllowlist) return { blocked: false };

    const key = this.cacheKey(source, message.senderId);
    const cached = this.cached(key);
    if (cached) return cached;

    try {
      const response = await this.fetch(
        `${source.apiUrl.replace(/\/$/, "")}/v1/contacts/detail`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Access-Token": source.accessToken,
          },
          body: JSON.stringify({ userName: message.senderId }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      const body = await response.json();
      if (!response.ok || body?.Success === false || body?.success === false) {
        throw new Error(`contact detail returned HTTP ${response.status}`);
      }
      const senderId = String(message.senderId || "").trim().toLowerCase();
      const contact = contactList(body).find(
        (item) => contactUserName(item).toLowerCase() === senderId,
      );
      if (!contact) throw new Error("contact detail did not include sender");
      if (isVerifiedOfficialAccount(contact)) {
        return this.remember(key, {
          blocked: true,
          reason: "verified-official-account",
        });
      }
      return this.remember(key, { blocked: false });
    } catch (error) {
      this.logger.warn("pad sender classification failed", {
        sourceId: source.id,
        senderId: message.senderId,
        error: error.message,
      });
      return {
        blocked: true,
        reason: "sender-classification-unavailable",
      };
    }
  }
}
