import fs from "node:fs/promises";
import path from "node:path";

const SECRET_FIELDS = new Set([
  "accessToken",
  "apiId",
  "apiHash",
  "llmApiKey",
  "webhookToken",
]);

function clone(value) {
  return structuredClone(value || {});
}

function preserveSecrets(next, previous) {
  if (next === undefined) return clone(previous);
  if (Array.isArray(next)) {
    const previousItems = Array.isArray(previous) ? previous : [];
    const previousById = new Map(
      previousItems
        .filter((item) => item && typeof item === "object" && item.id)
        .map((item) => [String(item.id), item]),
    );
    return next.map((item, index) => {
      const prior =
        item && typeof item === "object" && item.id
          ? previousById.get(String(item.id))
          : previousItems[index];
      return preserveSecrets(item, prior || {});
    });
  }
  if (!next || typeof next !== "object") return next;
  const output =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? clone(previous)
      : {};
  for (const [key, value] of Object.entries(next)) {
    if (SECRET_FIELDS.has(key) && value === "") {
      output[key] = previous?.[key] || "";
    } else {
      output[key] = preserveSecrets(value, previous?.[key]);
    }
  }
  return output;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key)) {
      output[key] = "";
      output[`${key}Configured`] = Boolean(item);
    } else {
      output[key] = redactSecrets(item);
    }
  }
  return output;
}

export class SettingsStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.settings = {};
  }

  async load() {
    try {
      this.settings = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.settings = {};
    }
    return clone(this.settings);
  }

  current() {
    return clone(this.settings);
  }

  publicSettings(fallback = {}) {
    return redactSecrets(
      Object.keys(this.settings).length ? this.settings : fallback,
    );
  }

  merged(next) {
    return preserveSecrets(clone(next), this.settings);
  }

  async save(next) {
    const merged = this.merged(next);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, this.file);
    await fs.chmod(this.file, 0o600);
    this.settings = merged;
    return clone(merged);
  }
}

export function serializeConfig(config) {
  return {
    channels: [...config.channels],
    outboundMode: config.outboundMode,
    identity: {
      selfId: config.identity.selfId,
      botNames: [...config.identity.botNames],
    },
    policy: {
      groupTriggers: [...config.policy.groupTriggers],
      ownerSenderIds: [...config.policy.ownerSenderIds],
      allowedChatIds: [...config.policy.allowedChatIds],
      allowedSenderIds: [...config.policy.allowedSenderIds],
      blockedSenderIds: [...config.policy.blockedSenderIds],
      allowSelf: config.policy.allowSelf,
    },
    assistant: { ...config.assistant },
    caseManagement: { ...config.caseManagement },
    knowledgeBase: { ...config.knowledgeBase },
    pad: {
      requireWriteConfirmation: config.pad.requireWriteConfirmation,
      sources: config.pad.sources.map((source) => ({
        id: source.id,
        displayName: source.displayName,
        selfId: source.selfId,
        enabled: source.enabled,
        wsUrl: source.wsUrl,
        apiUrl: source.apiUrl,
        accessToken: source.accessToken,
        accessTokenFile: source.accessTokenFile,
        allowSelf: source.allowSelf,
        selfChatPeers: [...source.selfChatPeers],
        acceptSelfChatPeerMessages: source.acceptSelfChatPeerMessages,
        ignoreAllowlist: source.ignoreAllowlist,
        allowedChatIds: [...source.allowedChatIds],
        blockedChatIds: [...source.blockedChatIds],
        allowedSenderIds: [...source.allowedSenderIds],
        blockedSenderIds: [...source.blockedSenderIds],
        privateNicknameAllowlist: [...source.privateNicknameAllowlist],
        triggerKeywords: [...source.triggerKeywords],
        botNames: [...source.botNames],
      })),
    },
    telegram: {
      sources: config.telegram.sources.map((source) => ({
        id: source.id,
        displayName: source.displayName,
        enabled: source.enabled,
        pythonBin: source.pythonBin,
        bridgeScript: source.bridgeScript,
        sessionPath: source.sessionPath,
        apiId: source.apiId,
        apiIdEnv: source.apiIdEnv,
        apiIdFile: source.apiIdFile,
        apiHash: source.apiHash,
        apiHashEnv: source.apiHashEnv,
        apiHashFile: source.apiHashFile,
        allowSelf: source.allowSelf,
        trustSelfAsOwner: source.trustSelfAsOwner,
        listenSelf: source.listenSelf,
        ignoreAllowlist: source.ignoreAllowlist,
        allowedChatIds: [...source.allowedChatIds],
        blockedChatIds: [...source.blockedChatIds],
        allowedSenderIds: [...source.allowedSenderIds],
        blockedSenderIds: [...source.blockedSenderIds],
        privateNicknameAllowlist: [...source.privateNicknameAllowlist],
        triggerKeywords: [...source.triggerKeywords],
        botNames: [...source.botNames],
      })),
    },
  };
}
