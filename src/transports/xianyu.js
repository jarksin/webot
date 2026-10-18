import crypto from "node:crypto";
import {
  normalizeXianyuEvent,
  xianyuStableId,
  XIANYU_MAX_AGE_MS,
  XIANYU_MAX_FUTURE_MS,
  XIANYU_MAX_OUTGOING_UNITS,
} from "../xianyu-sources.js";

export function xianyuSignature(body, secret) {
  if (!secret) throw new Error("Xianyu signing secret is missing");
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class XianyuTransport {
  constructor(config, outboundMode, fetchImpl = globalThis.fetch, channelEnabled = () => true) {
    this.config = config;
    this.outboundMode = outboundMode;
    this.fetch = fetchImpl;
    this.receipts = new Map();
    this.channelEnabled = channelEnabled;
    this.sendTails = new Map();
  }

  send(message, text) {
    const sourceId = message.sourceId;
    const previous = this.sendTails.get(sourceId) || Promise.resolve();
    const current = previous.catch(() => {})
      .then(() => this.sendOne(message, text))
      .finally(() => {
        if (this.sendTails.get(sourceId) === current) this.sendTails.delete(sourceId);
      });
    this.sendTails.set(sourceId, current);
    return current;
  }

  async sendOne(message, text) {
    if (!this.channelEnabled()) throw new Error("Xianyu channel is disabled");
    const source = this.config.sources.find((item) => item.id === message.sourceId);
    const target = message.xianyu;
    if (!source?.enabled || !source.secret || !target ||
      target.accountId !== source.accountId ||
      !target.chatId || !target.messageId || message.transport !== "xianyu" ||
      message.direction !== "incoming" || target.senderId === source.accountId) {
      throw new Error("Xianyu reply target is not bound to an enabled source");
    }
    try {
      if (!Number.isSafeInteger(message.timestamp) || message.timestamp <= 0 ||
        message.timestamp > Date.now() + XIANYU_MAX_FUTURE_MS) {
        throw new Error("invalid timestamp");
      }
      // Validate the persisted route independently of age; stale replies may
      // only retrieve an existing receipt, never dispatch a native send.
      const expected = normalizeXianyuEvent({
        ...target,
        text: message.text,
        timestamp: message.timestamp,
        direction: message.direction,
        type: message.messageType === 1 ? "text" : "",
      }, source, message.timestamp);
      if (["senderId", "selfId", "messageId", "chatId", "conversationId"]
        .some((key) => expected[key] !== message[key])) {
        throw new Error("routing mismatch");
      }
    } catch {
      throw new Error("Xianyu reply target is invalid");
    }
    if (typeof text !== "string" || !text.trim() ||
      text.length > XIANYU_MAX_OUTGOING_UNITS) {
      throw new Error("invalid Xianyu reply text");
    }
    const payload = {
      sourceId: source.id,
      accountId: source.accountId,
      chatId: target.chatId,
      inReplyTo: target.messageId,
      text,
    };
    const requestId = `xianyu-${crypto.createHash("sha256")
      .update(JSON.stringify(payload)).digest("hex")}`;
    if (this.outboundMode !== "live") {
      return { ok: true, dryRun: true, requestId };
    }
    const body = JSON.stringify({ requestId, ...payload });
    const receiptOnly = Date.now() - message.timestamp > XIANYU_MAX_AGE_MS;
    const operation = receiptOnly ? "receipt" : "send";
    let response;
    let receipt;
    try {
      response = await this.fetch(`${source.bridgeUrl}/v1/messages/${operation}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "x-webot-signature": xianyuSignature(body, source.secret),
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("bridge refused request");
      receipt = await response.json();
    } catch {
      // Never persist bridge response bodies or fetch errors containing secrets.
      throw new Error(receiptOnly
        ? "Xianyu bridge receipt lookup failed"
        : "Xianyu bridge delivery failed");
    }
    if (receipt?.ok !== true || receipt.status !== "sent" ||
      !xianyuStableId(receipt.messageId)) {
      throw new Error("Xianyu bridge did not confirm sent delivery");
    }
    if (!receiptOnly) this.receipts.set(source.id, { lastSentAt: Date.now() });
    return { ok: true, status: "sent", messageId: receipt.messageId, requestId };
  }
}
