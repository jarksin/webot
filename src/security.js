import crypto from "node:crypto";
import { telegramSourceForMessage } from "./telegram-sources.js";

export function validSignature(rawBody, header, secret) {
  if (!secret) return true;
  const supplied = String(header || "").replace(/^sha256=/i, "");
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(supplied.toLowerCase()),
    Buffer.from(expected),
  );
}

export function requesterAccess(
  message,
  ownerSenderIds = new Set(),
  config = null,
) {
  const senderId = String(message?.senderId || "").trim().toLowerCase();
  const owner = senderId && [...ownerSenderIds].some(
    (candidate) => String(candidate || "").trim().toLowerCase() === senderId,
  );
  if (owner) return "owner";
  if (
    config &&
    message?.transport === "telegram" &&
    message?.exactSelfChat === true &&
    message?.senderId === message?.selfId
  ) {
    const source = telegramSourceForMessage(config, message);
    if (source?.trustSelfAsOwner) return "owner";
  }
  return "public";
}
