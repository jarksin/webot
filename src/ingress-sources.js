import fs from "node:fs";
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

export function normalizeSource(value, env, defaults) {
  const id = String(value.id || value.source_id || "").trim();
  const selfId = String(value.self_wxid || value.selfId || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`invalid Pad source id: ${id || "<empty>"}`);
  }
  if (!selfId) throw new Error(`missing self_wxid for Pad source ${id}`);
  const accessTokenEnv = String(
    value.access_token_env || value.accessTokenEnv || "",
  ).trim();
  const environmentAccessToken = String(
    (accessTokenEnv && env[accessTokenEnv]) || "",
  ).trim();
  const inlineAccessToken = String(
    value.access_token || value.accessToken || "",
  ).trim();
  const accessTokenFile = String(
    value.access_token_file || value.accessTokenFile || "",
  ).trim();
  const fileAccessToken = accessTokenFile
    ? fs.readFileSync(path.resolve(accessTokenFile), "utf8").trim()
    : "";
  const defaultAccessToken =
    selfId.toLowerCase() === String(defaults.selfId || "").trim().toLowerCase()
      ? String(defaults.accessToken || "").trim()
      : "";
  const accessToken =
    environmentAccessToken ||
    fileAccessToken ||
    inlineAccessToken ||
    defaultAccessToken;
  return {
    id,
    displayName: String(value.display_name || value.displayName || id).trim(),
    selfId,
    wsUrl: String(value.ws_url || value.wsUrl || defaults.wsUrl || "").trim(),
    apiUrl: String(
      value.api_url || value.apiUrl || defaults.apiUrl || "",
    ).replace(/\/+$/, ""),
    accessTokenEnv,
    accessTokenFile,
    accessToken,
    credentialSource: environmentAccessToken
      ? "environment"
      : fileAccessToken
        ? "file"
        : inlineAccessToken
          ? "inline"
          : defaultAccessToken
            ? "legacy_default"
            : "",
    allowSelf: boolean(value.allow_self_chat ?? value.allowSelf, false),
    selfChatPeers: new Set(
      stringList(value.self_chat_peers ?? value.selfChatPeers),
    ),
    acceptSelfChatPeerMessages: boolean(
      value.accept_self_chat_peer_messages ??
        value.acceptSelfChatPeerMessages,
      false,
    ),
    ignoreAllowlist: boolean(
      value.ignore_allowlist ?? value.ignoreAllowlist,
      false,
    ),
    allowedChatIds: new Set(
      stringList(value.group_chat_ids ?? value.allowedChatIds),
    ),
    blockedChatIds: new Set(
      stringList(value.blocked_chat_ids ?? value.blockedChatIds),
    ),
    allowedSenderIds: new Set(
      stringList(value.private_sender_ids ?? value.allowedSenderIds),
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
    enabled: boolean(value.enabled, true),
    strictPolicy: true,
  };
}

export function loadPadSources(env, defaults, configuredSources) {
  if (Array.isArray(configuredSources)) {
    return validateSources(
      configuredSources.map((value) => normalizeSource(value, env, defaults)),
    );
  }
  const configuredPath = String(env.WEBOT_PAD_SOURCES_FILE || "").trim();
  if (!configuredPath) {
    if (!defaults.selfId) return [];
    return [
      {
        id: "default",
        displayName: "default",
        selfId: defaults.selfId,
        wsUrl: defaults.wsUrl,
        apiUrl: defaults.apiUrl,
        accessTokenEnv: "WEBOT_PAD_ACCESS_TOKEN",
        accessToken: defaults.accessToken,
        credentialSource: defaults.accessToken ? "legacy_default" : "",
        allowSelf: defaults.allowSelf,
        selfChatPeers: new Set(),
        acceptSelfChatPeerMessages: false,
        ignoreAllowlist: false,
        allowedChatIds: defaults.allowedChatIds,
        blockedChatIds: new Set(),
        allowedSenderIds: defaults.allowedSenderIds,
        blockedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        enabled: true,
        strictPolicy: false,
      },
    ];
  }

  const configPath = path.resolve(configuredPath);
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const values = Array.isArray(parsed) ? parsed : parsed.sources;
  if (!Array.isArray(values) || !values.length) {
    throw new Error(`Pad source config has no sources: ${configPath}`);
  }
  const sources = values.map((value) => normalizeSource(value, env, defaults));
  return validateSources(sources);
}

function validateSources(sources) {
  const ids = new Set();
  const accounts = new Set();
  for (const source of sources) {
    const id = source.id.toLowerCase();
    const account = source.selfId.toLowerCase();
    if (ids.has(id)) throw new Error(`duplicate Pad source id: ${source.id}`);
    if (accounts.has(account)) {
      throw new Error(`duplicate Pad source self_wxid: ${source.selfId}`);
    }
    ids.add(id);
    accounts.add(account);
  }
  return sources;
}

export function sourceForMessage(config, message) {
  const sources = config.pad.sources || [];
  const requested = String(message.sourceId || "").trim();
  if (requested) {
    return sources.find((source) => source.id === requested) || null;
  }
  return (
    sources.find((source) => source.id === "main") ||
    sources[0] ||
    config.pad
  );
}
