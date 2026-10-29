import crypto from "node:crypto";

// Account policy authorizes these two operations independently of chat triggers.
// Claim before sending: uncertain outcomes must never be retried on WS replay.
export async function handlePadAutoAction(message, { config, caseStore, transport, logger }) {
  if (message.transport !== "pad" || message.protocol === "qw_pad" ||
      message.direction !== "incoming" || !config.channels.has("pad")) return null;
  const source = config.pad.sources.find((item) => item.id === message.sourceId);
  const sender = message.messageType === 37
    ? message.friendRequest?.from_user_name || message.senderId : message.senderId;
  if (!source?.enabled || source.blockedSenderIds.has(sender) ||
      source.blockedChatIds.has(message.chatId)) return null;
  const friend = message.messageType === 37 && source.autoAcceptFriends;
  const packet = message.messageType === 49 && source.autoReceiveRedPackets &&
    Number(message.app?.red_packet?.app_message_type) === 2001;
  if (!friend && !packet) return null;
  const operation = friend ? "accept_friend" : "receive_red_packet";
  const result = (status) => ({ accepted: false, reason: `auto_${operation}:${status}` });
  if (config.outboundMode !== "live") return result("dry_run");
  const identity = friend
    ? message.friendRequest?.friend_request_id
    : message.app.red_packet.send_id || message.app.red_packet.pay_message_id || message.messageId;
  const hash = crypto.createHash("sha256")
    .update(JSON.stringify([source.id, operation, identity || message.messageId])).digest("hex");
  const key = `pad_auto_action:${hash}`;
  if (caseStore.runtimeSetting(key, "")) return result("already_attempted");
  const record = (status, error = "") => caseStore.setRuntimeSetting(key,
    JSON.stringify({ sourceId: source.id, messageId: message.messageId, operation, status, error, at: Date.now() }));
  record("attempting");
  try {
    if (friend) {
      if (!identity || message.friendRequest.accept_ready !== true) {
        record("missing_request_context");
        return result("missing_request_context");
      }
      await transport.request("/v1/contacts/accept-request", {
        confirm: true, request_id: `webot-friend-${hash}`,
        friend_request_id: identity,
      }, message);
    } else {
      if (!message.rawContent) {
        record("missing_packet_xml");
        return result("missing_packet_xml");
      }
      const response = await transport.request("/v1/payments/receive-red-packet", {
        confirm: true, request_id: `webot-receive-${hash}`, Xml: message.rawContent,
      }, message);
      const received = response.result?.Data ?? response.result;
      if (!received?.sendUserName || !received?.timingIdentifier) {
        throw new Error("Missing red-packet open context");
      }
      await transport.request("/v1/payments/open-red-packet", {
        confirm: true, request_id: `webot-open-${hash}`, Xml: message.rawContent,
        SendUserName: received.sendUserName, TimingIdentifier: received.timingIdentifier,
      }, message);
    }
    record("succeeded");
    logger.info("pad automatic action completed", { sourceId: source.id, operation, messageId: message.messageId });
    return result("succeeded");
  } catch (error) {
    record("failed_or_uncertain", String(error.message || error).slice(0, 500));
    logger.error("pad automatic action failed; inspect gateway operation record before retrying", {
      sourceId: source.id, operation, messageId: message.messageId,
    });
    return result("failed_or_uncertain");
  }
}
