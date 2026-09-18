import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stringList(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || "").split(/[,;\n]+/);
  return [
    ...new Set(items.map((item) => String(item || "").trim()).filter(Boolean)),
  ];
}

function boolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function expandHome(value) {
  const configured = String(value || "").trim();
  if (!configured) return "";
  if (configured === "~") return os.homedir();
  if (configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function executable(value) {
  const configured = String(value || "").trim();
  if (!configured || !configured.includes("/")) return configured;
  return expandHome(configured);
}

function credential(value, env, names) {
  const envName = String(
    value[names.envSnake] || value[names.envCamel] || names.defaultEnv || "",
  ).trim();
  const file = expandHome(
    value[names.fileSnake] || value[names.fileCamel] || "",
  );
  const environmentValue = String((envName && env[envName]) || "").trim();
  const fileValue = file ? fs.readFileSync(file, "utf8").trim() : "";
  const inlineValue = String(
    value[names.inlineSnake] || value[names.inlineCamel] || "",
  ).trim();
  return {
    value: environmentValue || fileValue || inlineValue,
    envName,
    file,
    source: environmentValue
      ? "environment"
      : fileValue
        ? "file"
        : inlineValue
          ? "inline"
          : "",
  };
}

export function normalizeTelegramSource(value, env, defaults = {}) {
  const id = String(value.id || value.source_id || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid Telegram source id: ${id || "<empty>"}`);
  }
  const apiId = credential(value, env, {
    envSnake: "api_id_env",
    envCamel: "apiIdEnv",
    fileSnake: "api_id_file",
    fileCamel: "apiIdFile",
    inlineSnake: "api_id",
    inlineCamel: "apiId",
    defaultEnv: "TG_API_ID",
  });
  const apiHash = credential(value, env, {
    envSnake: "api_hash_env",
    envCamel: "apiHashEnv",
    fileSnake: "api_hash_file",
    fileCamel: "apiHashFile",
    inlineSnake: "api_hash",
    inlineCamel: "apiHash",
    defaultEnv: "TG_API_HASH",
  });
  if (apiId.value && !/^\d+$/.test(apiId.value)) {
    throw new Error(`invalid Telegram api_id for source ${id}`);
  }
  return {
    id,
    displayName: String(
      value.display_name || value.displayName || id,
    ).trim(),
    enabled: boolean(value.enabled, true),
    pythonBin: executable(
      value.python_bin ||
        value.pythonBin ||
        env.WEBOT_TELEGRAM_PYTHON_BIN ||
        defaults.pythonBin ||
        "python3",
    ),
    bridgeScript: expandHome(
      value.bridge_script ||
        value.bridgeScript ||
        env.WEBOT_TELEGRAM_BRIDGE_SCRIPT ||
        defaults.bridgeScript,
    ),
    sessionPath: expandHome(
      value.session_path ||
        value.sessionPath ||
        env.WEBOT_TELEGRAM_SESSION_PATH ||
        defaults.sessionPath ||
        "~/.webot/telegram",
    ),
    apiId: apiId.value,
    apiIdEnv: apiId.envName,
    apiIdFile: apiId.file,
    apiHash: apiHash.value,
    apiHashEnv: apiHash.envName,
    apiHashFile: apiHash.file,
    credentialSource: apiId.source && apiHash.source
      ? apiId.source === apiHash.source
        ? apiId.source
        : "mixed"
      : "",
    allowSelf: boolean(value.allow_self ?? value.allowSelf, true),
    trustSelfAsOwner: boolean(
      value.trust_self_as_owner ?? value.trustSelfAsOwner,
      false,
    ),
    listenSelf: boolean(
      value.listen_self ?? value.listenSelf,
      true,
    ),
    ignoreAllowlist: boolean(
      value.ignore_allowlist ?? value.ignoreAllowlist,
      false,
    ),
    allowedChatIds: new Set(
      stringList(value.allowed_chat_ids ?? value.allowedChatIds),
    ),
    blockedChatIds: new Set(
      stringList(value.blocked_chat_ids ?? value.blockedChatIds),
    ),
    allowedSenderIds: new Set(
      stringList(value.allowed_sender_ids ?? value.allowedSenderIds),
    ),
    blockedSenderIds: new Set(
      stringList(value.blocked_sender_ids ?? value.blockedSenderIds),
    ),
    privateNicknameAllowlist: new Set(
      stringList(
        value.private_nickname_allowlist ?? value.privateNicknameAllowlist,
      ),
    ),
    triggerKeywords: new Set(
      stringList(value.trigger_keywords ?? value.triggerKeywords),
    ),
    botNames: new Set(stringList(value.bot_names ?? value.botNames)),
    strictPolicy: true,
  };
}

export function loadTelegramSources(env, defaults, configuredSources) {
  if (Array.isArray(configuredSources)) {
    return validateTelegramSources(
      configuredSources.map((value) =>
        normalizeTelegramSource(value, env, defaults)
      ),
    );
  }
  const hasLegacyConfig = Boolean(
    env.TG_API_ID ||
      env.TG_API_HASH ||
      env.WEBOT_TELEGRAM_SESSION_PATH,
  );
  if (!hasLegacyConfig) return [];
  return validateTelegramSources([
    normalizeTelegramSource({
      id: "telegram",
      displayName: "Telegram",
      apiIdEnv: "TG_API_ID",
      apiHashEnv: "TG_API_HASH",
      sessionPath: env.WEBOT_TELEGRAM_SESSION_PATH,
      allowSelf: true,
      trustSelfAsOwner: false,
      listenSelf: true,
    }, env, defaults),
  ]);
}

function validateTelegramSources(sources) {
  const ids = new Set();
  const sessions = new Set();
  for (const source of sources) {
    const id = source.id.toLowerCase();
    const session = source.sessionPath.toLowerCase();
    if (ids.has(id)) {
      throw new Error(`duplicate Telegram source id: ${source.id}`);
    }
    if (sessions.has(session)) {
      throw new Error(
        `duplicate Telegram session path: ${source.sessionPath}`,
      );
    }
    ids.add(id);
    sessions.add(session);
  }
  return sources;
}

export function telegramSourceForMessage(config, message) {
  const sources = config.telegram?.sources || [];
  const requested = String(message?.sourceId || "").trim();
  if (requested) {
    return sources.find((source) => source.id === requested) || null;
  }
  return sources[0] || null;
}

function containsCaseInsensitive(values, candidate) {
  const target = String(candidate || "").trim().toLowerCase();
  return Boolean(
    target &&
      [...(values || [])].some(
        (value) => String(value || "").trim().toLowerCase() === target,
      ),
  );
}

export function telegramGroupIngressDecision(config, message) {
  if (
    message?.transport !== "telegram" ||
    message?.chatType !== "group"
  ) {
    return { accepted: true };
  }
  const source = telegramSourceForMessage(config, message);
  if (!source) {
    return { accepted: false, reason: "source-not-configured" };
  }
  if (containsCaseInsensitive(source.blockedChatIds, message.chatId)) {
    return { accepted: false, reason: "chat-blocked" };
  }
  if (
    !source.ignoreAllowlist &&
    !containsCaseInsensitive(source.allowedChatIds, message.chatId)
  ) {
    return { accepted: false, reason: "chat-not-allowed" };
  }
  return { accepted: true };
}
