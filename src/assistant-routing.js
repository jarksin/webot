function nonEmpty(value) {
  return String(value || "").trim();
}

export function isSelfConversation(message) {
  return Boolean(
    message?.chatType === "private" &&
      message.selfConversation === true,
  );
}

export function assistantConfigForMessage(config = {}, message = {}) {
  const self = isSelfConversation(message);
  return {
    ...config,
    codexModel: nonEmpty(
      self ? config.selfCodexModel : config.otherCodexModel,
    ) || nonEmpty(config.codexModel),
    reasoningEffort: nonEmpty(
      self ? config.selfReasoningEffort : config.otherReasoningEffort,
    ) || nonEmpty(config.reasoningEffort),
  };
}
