import { sourceForMessage } from "./ingress-sources.js";

function has(set, value) {
  return value && set.has(String(value));
}

function hasCaseInsensitive(set, value) {
  const target = String(value || "").trim().toLowerCase();
  return Boolean(
    target &&
      [...(set || [])].some(
        (item) => String(item || "").trim().toLowerCase() === target,
      ),
  );
}

function hasAiReplyPrefix(text) {
  return /^\s*【AI(?:\s+\d+\/\d+)?】/i.test(String(text || ""));
}

function hasBotNamePrefix(text, botNames) {
  const value = String(text || "").trim();
  return [...(botNames || [])].some((name) => {
    const escaped = String(name || "")
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return Boolean(
      escaped && new RegExp(`^@${escaped}(?:[\\s,:，：-]|$)`, "i").test(value),
    );
  });
}

function isPadOfficialAccount(message) {
  return (
    message.transport === "pad" &&
    message.chatType === "private" &&
    /^gh_/i.test(String(message.senderId || "").trim())
  );
}

function stripTrigger(text, triggers, botNames) {
  let output = text.trim();
  for (const prefix of [...triggers, ...botNames]) {
    const pattern = new RegExp(
      `^@?${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,:，：-]*`,
      "i",
    );
    output = output.replace(pattern, "");
  }
  return output.trim();
}

export function acceptedMessage(message, config) {
  if (!message?.text?.trim() || !message.chatId || !message.senderId) {
    return { accepted: false, reason: "empty" };
  }
  const source =
    message.transport === "pad" ? sourceForMessage(config, message) : null;
  const botNames = source?.botNames?.size
    ? source.botNames
    : config.identity.botNames;
  const privateBotPrefix =
    message.chatType === "private" &&
    hasBotNamePrefix(message.text, botNames);
  if (message.transport === "pad" && config.pad.sources.length && !source) {
    return { accepted: false, reason: "source-not-configured" };
  }
  if (isPadOfficialAccount(message)) {
    return { accepted: false, reason: "official-account" };
  }
  if (
    !source?.strictPolicy &&
    !config.policy.allowSelf &&
    message.selfId &&
    message.senderId === message.selfId
  ) {
    return { accepted: false, reason: "self" };
  }
  if (has(config.policy.blockedSenderIds, message.senderId)) {
    return { accepted: false, reason: "blocked" };
  }
  if (source?.strictPolicy) {
    if (message.selfConversation && hasAiReplyPrefix(message.text)) {
      return { accepted: false, reason: "assistant-echo" };
    }
    if (message.selfPeer && message.direction === "outgoing") {
      return { accepted: false, reason: "self-peer-outgoing" };
    }
    if (message.exactSelfChat) {
      if (!source.allowSelf) return { accepted: false, reason: "self" };
    } else if (message.selfPeer) {
      if (message.direction !== "incoming") {
        return { accepted: false, reason: "self-peer-direction" };
      }
      if (!source.acceptSelfChatPeerMessages) {
        return {
          accepted: false,
          reason: "self-peer-incoming-disabled",
        };
      }
    } else if (message.chatType === "group") {
      if (
        !source.ignoreAllowlist &&
        !hasCaseInsensitive(source.allowedChatIds, message.chatId)
      ) {
        return { accepted: false, reason: "chat-not-allowed" };
      }
    } else if (
      !source.ignoreAllowlist &&
      !hasCaseInsensitive(source.allowedSenderIds, message.senderId) &&
      !hasCaseInsensitive(source.privateNicknameAllowlist, message.senderName) &&
      !privateBotPrefix
    ) {
      return { accepted: false, reason: "sender-not-allowed" };
    }
  }
  if (
    !source?.strictPolicy &&
    config.policy.allowedChatIds.size > 0 &&
    !has(config.policy.allowedChatIds, message.chatId)
  ) {
    return { accepted: false, reason: "chat-not-allowed" };
  }
  if (
    !source?.strictPolicy &&
    config.policy.allowedSenderIds.size > 0 &&
    !has(config.policy.allowedSenderIds, message.senderId)
  ) {
    return { accepted: false, reason: "sender-not-allowed" };
  }

  if (message.chatType === "group") {
    const lowerText = message.text.toLowerCase();
    const groupTriggers = source?.triggerKeywords?.size
      ? source.triggerKeywords
      : config.policy.groupTriggers;
    const mentioned =
      (message.selfId && message.mentions.includes(message.selfId)) ||
      [...botNames].some((name) =>
        lowerText.includes(`@${name.toLowerCase()}`),
      );
    const triggered = [...groupTriggers].some((trigger) =>
      lowerText.startsWith(trigger.toLowerCase()),
    );
    if (!mentioned && !triggered) {
      return {
        accepted: false,
        reason: "group-not-triggered",
        retainGroupContext: true,
      };
    }
  }

  return {
    accepted: true,
    text: stripTrigger(
      message.text,
      source?.triggerKeywords?.size
        ? source.triggerKeywords
        : config.policy.groupTriggers,
      source?.botNames?.size ? source.botNames : config.identity.botNames,
    ),
  };
}

export class WebotRuntime {
  constructor({ config, provider, store, transports, logger = console }) {
    this.config = config;
    this.provider = provider;
    this.store = store;
    this.transports = transports;
    this.logger = logger;
    this.seen = new Map();
    this.queues = new Map();
  }

  dedupeKey(message) {
    return `${message.transport}:${message.sourceId || ""}:${message.chatId}:${message.messageId}`;
  }

  duplicate(message) {
    const now = Date.now();
    const key = this.dedupeKey(message);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    if (this.seen.size > 5000) {
      for (const [candidate, at] of this.seen) {
        if (now - at > 6 * 60 * 60 * 1000) this.seen.delete(candidate);
      }
    }
    return false;
  }

  receive(message) {
    const key = `${message.transport}:${message.conversationId || message.chatId}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.process(message))
      .finally(() => {
        if (this.queues.get(key) === current) this.queues.delete(key);
      });
    this.queues.set(key, current);
    return current;
  }

  async process(message) {
    if (this.duplicate(message)) return { accepted: false, reason: "duplicate" };
    const decision = acceptedMessage(message, this.config);
    if (!decision.accepted) return decision;

    const cleanMessage = { ...message, text: decision.text || message.text };
    const chatKey = `${message.transport}:${message.conversationId || `${message.chatType}:${message.chatId}`}`;
    await this.store.append(chatKey, "user", cleanMessage.text);
    const history = await this.store.history(chatKey);
    const reply = await this.provider.reply({
      message: cleanMessage,
      history,
    });
    await this.store.append(chatKey, "assistant", reply);

    const transport = this.transports[message.transport];
    if (!transport) {
      throw new Error(`transport is not configured: ${message.transport}`);
    }
    const result = await transport.send(cleanMessage, reply);
    this.logger.info("message handled", {
      transport: message.transport,
      chatType: message.chatType,
      chatId: message.chatId,
      dryRun: Boolean(result.dryRun),
    });
    return { accepted: true, reply, outbound: result };
  }
}
