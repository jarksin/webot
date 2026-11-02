// Group-specific behavior is installation configuration, never message metadata.
export function normalizeGroupPolicies(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).map(([chatId, policy]) => [
    chatId,
    {
      listenAll: policy.listenAll === true,
      ignoredSenderIds: Array.isArray(policy.ignoredSenderIds) ? policy.ignoredSenderIds : [],
      mentionOnlySenderIds: Array.isArray(policy.mentionOnlySenderIds) ? policy.mentionOnlySenderIds : [],
      batchWindowMs: Math.min(60_000, Math.max(0, Number(policy.batchWindowMs) || 0)),
      workerDelayMs: Math.min(120_000, Math.max(0, Number(policy.workerDelayMs) || 0)),
      humanReplySenderIds: Array.isArray(policy.humanReplySenderIds) ? policy.humanReplySenderIds : [],
      ignoreAcknowledgements: policy.ignoreAcknowledgements === true,
      supportInstructions: String(policy.supportInstructions || "").trim(),
    },
  ]));
}

export function groupPolicyForMessage(config, message) {
  if (message?.transport !== "pad" || message.chatType !== "group") return null;
  const source = config?.pad?.sources?.find((item) => item.id === message.sourceId);
  if (!source || source.enabled === false) return null;
  return source.groupPolicies?.[message.chatId] || null;
}

export function isAcknowledgement(text) {
  return /^(?:好的|好哒|好滴|好嘞|好|嗯嗯|嗯|哦哦|哦|噢|收到|明白了|明白|了解了|了解|知道了|谢谢你|谢谢|感谢|多谢|辛苦了|ok|okay|thanks|thank you)[\s。.!！,，~～👍🙏]*$/iu.test(String(text || "").trim());
}
