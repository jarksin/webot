import path from "node:path";
import os from "node:os";
import { loadPadSources } from "./ingress-sources.js";
import { loadTelegramSources } from "./telegram-sources.js";

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function value(setting, fallback) {
  return setting === undefined ? fallback : setting;
}

function workingDirectory(env, settings, defaultDataDir) {
  const configured = String(settings.workingDirectory || "").trim();
  const legacyWorkspace = path.resolve(defaultDataDir, "workspace");
  const sourceRepository =
    String(env.WEBOT_RUNTIME_MODE || "").trim() === "source"
      ? String(env.WEBOT_REPO_DIR || "").trim()
      : "";
  const fallback =
    String(env.WEBOT_CODEX_WORKDIR || "").trim() ||
    sourceRepository ||
    legacyWorkspace;
  if (!configured) return path.resolve(fallback);
  if (sourceRepository && path.resolve(configured) === legacyWorkspace) {
    return path.resolve(sourceRepository);
  }
  return path.resolve(configured);
}

function stringSet(valueToParse, fallback = "") {
  return new Set(
    (Array.isArray(valueToParse)
      ? valueToParse
      : String(valueToParse ?? fallback).split(/[,;\n]+/))
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  );
}

export function loadConfig(env = process.env, settings = {}) {
  const channels = stringSet(
    settings.channels,
    env.WEBOT_CHANNELS || "none",
  );
  channels.delete("none");
  const identitySettings = settings.identity || {};
  const policySettings = settings.policy || {};
  const assistantSettings = settings.assistant || {};
  const padSettings = settings.pad || {};
  const telegramSettings = settings.telegram || {};
  const kbSettings = settings.knowledgeBase || {};
  const caseSettings = settings.caseManagement || {};
  const defaultDataDir =
    env.WEBOT_DATA_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "Webot");
  const knowledgeLocalDir =
    String(kbSettings.localDir || "").trim() ||
    path.join(defaultDataDir, "knowledge");
  const selfId = value(identitySettings.selfId, env.WEBOT_SELF_WXID || "");
  const allowedChatIds = stringSet(
    policySettings.allowedChatIds,
    env.WEBOT_ALLOWED_CHAT_IDS,
  );
  const allowedSenderIds = stringSet(
    policySettings.allowedSenderIds,
    env.WEBOT_ALLOWED_SENDER_IDS,
  );
  const allowSelf = value(
    policySettings.allowSelf,
    boolean(env.WEBOT_ALLOW_SELF),
  );
  const pad = {
    wsUrl: value(padSettings.wsUrl, env.WEBOT_PAD_WS_URL || ""),
    apiUrl: value(
      padSettings.apiUrl,
      env.WEBOT_PAD_API_URL || "http://127.0.0.1:18102/api",
    ),
    accessToken: value(
      padSettings.accessToken,
      env.WEBOT_PAD_ACCESS_TOKEN || "",
    ),
    requireWriteConfirmation: value(
      padSettings.requireWriteConfirmation,
      boolean(env.WEBOT_PAD_REQUIRE_WRITE_CONFIRMATION),
    ),
  };
  pad.sources = loadPadSources(env, {
    selfId,
    wsUrl: pad.wsUrl,
    apiUrl: pad.apiUrl,
    accessToken: pad.accessToken,
    allowSelf,
    allowedChatIds,
    allowedSenderIds,
  }, padSettings.sources);
  const telegram = {
    sources: loadTelegramSources(env, {
      pythonBin: env.WEBOT_TELEGRAM_PYTHON_BIN || "python3",
      bridgeScript: path.join(
        env.WEBOT_REPO_DIR || process.cwd(),
        "scripts",
        "telegram_bridge.py",
      ),
      sessionPath:
        env.WEBOT_TELEGRAM_SESSION_PATH || "~/.webot/telegram",
    }, telegramSettings.sources),
  };

  return {
    server: {
      host: env.WEBOT_HOST || "127.0.0.1",
      port: integer(env.WEBOT_PORT, 18120),
    },
    logLevel: env.WEBOT_LOG_LEVEL || "info",
    dataDir: path.resolve(
      defaultDataDir,
    ),
    stateDir: path.resolve(
      env.WEBOT_STATE_DIR ||
        path.join(defaultDataDir, "sessions"),
    ),
    channels,
    outboundMode:
      value(settings.outboundMode, env.WEBOT_OUTBOUND_MODE) === "live"
        ? "live"
        : "dry-run",
    identity: {
      selfId,
      botNames: stringSet(
        identitySettings.botNames,
        env.WEBOT_BOT_NAMES || "Webot",
      ),
    },
    policy: {
      groupTriggers: stringSet(
        policySettings.groupTriggers,
        env.WEBOT_GROUP_TRIGGERS || "webot,机器人",
      ),
      ownerSenderIds: stringSet(
        policySettings.ownerSenderIds,
        env.WEBOT_OWNER_SENDER_IDS,
      ),
      allowedChatIds,
      allowedSenderIds,
      blockedSenderIds: stringSet(
        policySettings.blockedSenderIds,
        env.WEBOT_BLOCKED_SENDER_IDS,
      ),
      allowSelf,
    },
    assistant: {
      mode: value(assistantSettings.mode, env.WEBOT_ASSISTANT || "codex"),
      systemPrompt: value(
        assistantSettings.systemPrompt,
        env.WEBOT_SYSTEM_PROMPT ||
          "You are a concise and helpful WeChat assistant.",
      ),
      historyTurns: integer(
        value(assistantSettings.historyTurns, env.WEBOT_HISTORY_TURNS),
        12,
      ),
      timeoutMs: Math.max(
        0,
        integer(
          value(assistantSettings.timeoutMs, env.WEBOT_ASSISTANT_TIMEOUT_MS),
          0,
        ),
      ),
      webhookUrl: value(
        assistantSettings.webhookUrl,
        env.WEBOT_ASSISTANT_WEBHOOK_URL || "",
      ),
      webhookToken: value(
        assistantSettings.webhookToken,
        env.WEBOT_ASSISTANT_WEBHOOK_TOKEN || "",
      ),
      llmBaseUrl: value(
        assistantSettings.llmBaseUrl,
        env.WEBOT_LLM_BASE_URL || "https://api.openai.com/v1",
      ),
      llmApiKey: value(
        assistantSettings.llmApiKey,
        env.WEBOT_LLM_API_KEY || "",
      ),
      llmModel: value(
        assistantSettings.llmModel,
        env.WEBOT_LLM_MODEL || "",
      ),
      codexBin: value(
        assistantSettings.codexBin,
        env.WEBOT_CODEX_BIN || "",
      ),
      codexHome: value(
        assistantSettings.codexHome,
        env.WEBOT_CODEX_HOME || env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      ),
      workingDirectory: workingDirectory(
        env,
        assistantSettings,
        defaultDataDir,
      ),
      codexModel: value(
        assistantSettings.codexModel,
        env.WEBOT_CODEX_MODEL || "",
      ),
      selfCodexModel: value(
        assistantSettings.selfCodexModel,
        env.WEBOT_CODEX_SELF_MODEL || "",
      ),
      otherCodexModel: value(
        assistantSettings.otherCodexModel,
        env.WEBOT_CODEX_OTHER_MODEL || "",
      ),
      reasoningEffort: value(
        assistantSettings.reasoningEffort,
        env.WEBOT_CODEX_REASONING_EFFORT || "",
      ),
      selfReasoningEffort: value(
        assistantSettings.selfReasoningEffort,
        env.WEBOT_CODEX_SELF_REASONING_EFFORT || "",
      ),
      otherReasoningEffort: value(
        assistantSettings.otherReasoningEffort,
        env.WEBOT_CODEX_OTHER_REASONING_EFFORT || "",
      ),
      serviceTier: value(
        assistantSettings.serviceTier,
        env.WEBOT_CODEX_SERVICE_TIER || "",
      ),
    },
    knowledgeBase: {
      enabled: value(kbSettings.enabled, false),
      remote: value(kbSettings.remote, ""),
      branch: value(kbSettings.branch, "main"),
      localDir: path.resolve(knowledgeLocalDir),
      productMetadataUrl: value(
        kbSettings.productMetadataUrl,
        "https://webot.win/health",
      ),
      syncIntervalSeconds: integer(
        value(kbSettings.syncIntervalSeconds, 900),
        900,
      ),
      maxNotes: integer(value(kbSettings.maxNotes, 4), 4),
      maxCharsPerNote: integer(value(kbSettings.maxCharsPerNote, 4000), 4000),
      requireApproved: value(kbSettings.requireApproved, true),
    },
    caseManagement: {
      autoRun: value(caseSettings.autoRun, true),
      autoSend: value(caseSettings.autoSend, true),
      groupContextLimit: Math.min(
        Math.max(integer(value(caseSettings.groupContextLimit, 50), 50), 0),
        200,
      ),
      groupContextRetentionHours: Math.min(
        Math.max(
          integer(value(caseSettings.groupContextRetentionHours, 168), 168),
          1,
        ),
        24 * 365,
      ),
      groupContextMaxMessages: Math.min(
        Math.max(
          integer(value(caseSettings.groupContextMaxMessages, 2000), 2000),
          100,
        ),
        100_000,
      ),
      ownerIntermediateItems: value(
        caseSettings.ownerIntermediateItems,
        boolean(env.WEBOT_OWNER_INTERMEDIATE_ITEMS),
      ),
      workerConcurrency: integer(
        value(caseSettings.workerConcurrency, 2),
        2,
      ),
      providerTransientRetryMax: Math.min(
        Math.max(
          integer(value(caseSettings.providerTransientRetryMax, 1), 1),
          0,
        ),
        3,
      ),
      providerTransientRetryDelayMs: Math.min(
        Math.max(
          integer(value(caseSettings.providerTransientRetryDelayMs, 1500), 1500),
          0,
        ),
        30_000,
      ),
    },
    hook: {
      apiUrl: env.WEBOT_HOOK_API_URL || "http://127.0.0.1:58080",
      accessToken: env.WEBOT_HOOK_ACCESS_TOKEN || "",
      callbackSecret: env.WEBOT_HOOK_CALLBACK_SECRET || "",
    },
    pad,
    telegram,
  };
}
