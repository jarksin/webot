import path from "node:path";
import { CaseManager } from "./case-manager.js";
import { CaseStore } from "./case-store.js";
import {
  directoryContactCursor,
  directoryContactIds,
  directoryEntriesFromContacts,
  isDirectoryContactId,
} from "./contact-directory.js";
import { loadConfig } from "./config.js";
import { KnowledgeBaseCloud } from "./kb-cloud.js";
import { probeOptSource } from "./opt-status.js";
import { PadSenderClassifier } from "./pad-sender-classifier.js";
import { createProvider } from "./providers.js";
import { codexRuntimeStatus } from "./codex-provider.js";
import { WebotRuntime } from "./runtime.js";
import { SessionStore } from "./session-store.js";
import { serializeConfig } from "./settings-store.js";
import { requesterAccess } from "./security.js";
import { createSourceActivator } from "./source-activation.js";
import { telegramGroupIngressDecision } from "./telegram-sources.js";
import { WorkspacePolicy } from "./workspace-policy.js";
import { HookTransport } from "./transports/hook.js";
import {
  PadTransport,
  PadWebSocketClient,
} from "./transports/pad.js";
import {
  TelegramBridgeClient,
  TelegramTransport,
} from "./transports/telegram.js";
import { WEBOT_VERSION } from "./version.js";

const DIRECTORY_DETAIL_BATCH_SIZE = 20;
const PAD_BUSINESS_REQUEST_GAP_MS = 10_000;
const DIRECTORY_MAX_LIST_PAGES = 20;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canonicalValue(value) {
  if (value instanceof Set) {
    return [...value].map(canonicalValue).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function connectorSignature(config) {
  return JSON.stringify(canonicalValue({
    channels: config.channels,
    dataDir: config.dataDir,
    stateDir: config.stateDir,
    assistantWorkingDirectory: config.assistant.workingDirectory,
    pad: config.pad,
    telegram: config.telegram,
  }));
}

export class WebotApplication {
  constructor({
    env = process.env,
    settingsStore,
    logger = console,
    fetchImpl = globalThis.fetch,
  }) {
    this.env = env;
    this.settingsStore = settingsStore;
    this.logger = logger;
    this.config = null;
    this.runtime = null;
    this.knowledgeBase = null;
    this.padClients = [];
    this.telegramClients = [];
    this.padStatuses = new Map();
    this.padIngressCounts = new Map();
    this.telegramIngressCounts = new Map();
    this.padSenderClassifier = null;
    this.transports = null;
    this.padMediaRequestTails = new Map();
    this.padMediaLastRequestAt = new Map();
    this.padTimer = null;
    this.caseStore = null;
    this.caseManager = null;
    this.workspacePolicy = null;
    this.connectorsStarted = false;
    this.pendingSettings = null;
    this.settingsApplyTimer = null;
    this.startedAt = Date.now();
    this.sourceActivator = createSourceActivator({ env });
    this.fetch = fetchImpl;
  }

  async initialize() {
    const settings = await this.settingsStore.load();
    await this.applySettings(settings);
  }

  providerFor(config) {
    const accessForMessage = (message) =>
      requesterAccess(
        message,
        config.policy.ownerSenderIds,
        config,
      );
    return {
      accessForMessage,
      provider: createProvider(config.assistant, {
        requesterAccess: accessForMessage,
        searchKnowledge: (query, context) =>
          this.knowledgeBase.search(query, context),
        readAgentPolicy: () => this.workspacePolicy.read(),
      }),
    };
  }

  async applySettings(settings) {
    await this.stopConnectors();
    this.config = loadConfig(this.env, settings);
    if (!this.caseStore) {
      this.caseStore = new CaseStore(
        path.join(this.config.dataDir, "webot.sqlite"),
      );
      const codex = codexRuntimeStatus(this.config.assistant, this.env);
      const reconciled = this.caseStore.reconcileCodexUsage({
        codexHome: codex.home,
        model: codex.effective.model,
        reasoningEffort: codex.effective.reasoningEffort,
        env: this.env,
      });
      if (reconciled.updated) {
        this.logger.info("Reconciled Codex session usage", reconciled);
      }
    }
    this.knowledgeBase = new KnowledgeBaseCloud(
      this.config.knowledgeBase,
      this.logger,
    );
    this.workspacePolicy = new WorkspacePolicy(
      path.join(this.config.dataDir, "workspace"),
    );
    await this.workspacePolicy.ensure();
    const { accessForMessage, provider } = this.providerFor(this.config);
    const store = new SessionStore(
      this.config.stateDir,
      this.config.assistant.historyTurns,
    );
    const telegramTransport = new TelegramTransport(
      this.config.telegram,
      this.config.outboundMode,
      this.logger,
    );
    const transports = {
      hook: new HookTransport(
        this.config.hook,
        this.config.outboundMode,
        this.logger,
      ),
      pad: new PadTransport(
        this.config.pad,
        this.config.outboundMode,
        this.logger,
        this.fetch,
        {
          resolveMentionDisplayName: (message) =>
            this.caseStore.directoryDisplayName(
              message.sourceId,
              message.senderId,
            ),
        },
      ),
      telegram: telegramTransport,
    };
    this.transports = transports;
    this.runtime = new WebotRuntime({
      config: this.config,
      provider,
      store,
      transports,
      logger: this.logger,
    });
    this.padSenderClassifier = new PadSenderClassifier(this.config.pad, {
      logger: this.logger,
    });
    this.caseManager = new CaseManager({
      config: this.config,
      provider,
      sessionStore: store,
      caseStore: this.caseStore,
      transports,
      requesterAccess: accessForMessage,
      afterOwnerRun: (context) => this.sourceActivator.activate(context),
      logger: this.logger,
    });
    this.padClients = this.config.channels.has("pad")
      ? this.config.pad.sources
          .filter(
            (source) =>
              source.enabled &&
              source.wsUrl &&
              source.accessToken,
          )
          .map(
            (source) =>
              new PadWebSocketClient(
                source,
                source,
                (message) => this.receive(message),
                this.logger,
              ),
          )
      : [];
    this.telegramClients = this.config.channels.has("telegram")
      ? this.config.telegram.sources
          .filter(
            (source) =>
              source.enabled &&
              source.apiId &&
              source.apiHash &&
              source.sessionPath &&
              source.bridgeScript,
          )
          .map(
            (source) =>
              new TelegramBridgeClient(
                source,
                (message) => this.receive(message),
                this.logger,
              ),
          )
      : [];
    telegramTransport.setClients(this.telegramClients);
    if (this.connectorsStarted) await this.startConnectors();
  }

  async receive(message) {
    const telegramGroupDecision = telegramGroupIngressDecision(
      this.config,
      message,
    );
    if (!telegramGroupDecision.accepted) return telegramGroupDecision;

    if (["pad", "telegram"].includes(message.transport)) {
      const key = message.sourceId || "default";
      const counts = message.transport === "pad"
        ? this.padIngressCounts
        : this.telegramIngressCounts;
      counts.set(
        key,
        Number(counts.get(key) || 0) + 1,
      );
      const contextSettings = this.caseManager.groupContextSettings();
      this.caseStore.ingestSyncedMessage(message, {
        retentionHours: contextSettings.retentionHours,
        maxMessages: contextSettings.maxMessages,
      });
      this.caseStore.observeIdentity(message);
    }
    message = this.hydrateReferencedMessage(message);
    if (message.transport === "pad") {
      const classification = await this.padSenderClassifier.classify(message);
      if (classification.blocked) {
        const result = { accepted: false, reason: classification.reason };
        this.caseStore.markSyncedMessageResult(message, result);
        return result;
      }
      if (
        requesterAccess(message, this.config.policy.ownerSenderIds) === "owner"
      ) {
        message = await this.hydratePadMedia(message);
      }
    }
    try {
      const result = await this.caseManager.receive(message);
      this.caseStore.markSyncedMessageResult(message, result);
      return result;
    } catch (error) {
      this.caseStore.markSyncedMessageResult(message, {
        accepted: false,
        reason: "processing-error",
      });
      throw error;
    }
  }

  hydrateReferencedMessage(message) {
    const reference = message?.reference;
    const referenceId = String(reference?.messageId || "").trim();
    if (!referenceId || !["pad", "telegram"].includes(message?.transport)) {
      return message;
    }
    const stored = this.caseStore.syncedMessageByMessageId(
      message.sourceId,
      referenceId,
    );
    if (!stored) return message;
    const metadata = stored.metadata || {};
    return {
      ...message,
      reference: {
        ...reference,
        messageId: referenceId,
        messageType: reference.messageType || metadata.messageType,
        senderId: reference.senderId || stored.sender_id,
        senderName: reference.senderName || stored.sender_name,
        text: stored.text || reference.text || "",
        attachments: stored.attachments?.length
          ? stored.attachments
          : reference.attachments,
        rawContent: metadata.rawContent || reference.rawContent,
        app: metadata.app || reference.app,
        originalMessage: {
          messageId: stored.message_id,
          text: stored.text,
          attachments: stored.attachments,
        },
      },
    };
  }

  async serializePadMediaRequest(sourceId, operation) {
    const key = String(sourceId || "default");
    const previous = this.padMediaRequestTails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const last = Number(this.padMediaLastRequestAt.get(key) || 0);
      const wait = PAD_BUSINESS_REQUEST_GAP_MS - (Date.now() - last);
      if (last && wait > 0) await sleep(wait);
      this.padMediaLastRequestAt.set(key, Date.now());
      return operation();
    });
    this.padMediaRequestTails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.padMediaRequestTails.get(key) === current) {
        this.padMediaRequestTails.delete(key);
      }
    }
  }

  async hydratePadMedia(message) {
    const attachments = Array.isArray(message.attachments)
      ? [...message.attachments]
      : [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (
        attachment?.kind !== "image" ||
        !attachment?.downloadContext?.endpoint
      ) {
        continue;
      }
      try {
        const cached = await this.serializePadMediaRequest(
          message.sourceId,
          () => this.transports.pad.downloadInboundAttachment(
            message,
            attachment,
            this.config.dataDir,
          ),
        );
        attachments[index] = { ...attachment, ...cached };
      } catch (error) {
        attachments[index] = {
          ...attachment,
          error: String(error.message || error),
        };
        this.logger.warn("pad inbound image cache failed", {
          sourceId: message.sourceId,
          messageId: message.messageId,
          error: error.message,
        });
      }
    }
    let reference = message.reference;
    if (reference && Array.isArray(reference.attachments)) {
      const hydratedReference = await this.hydratePadMedia({
        ...message,
        messageId: reference.messageId || message.messageId,
        attachments: reference.attachments,
        reference: null,
      });
      reference = { ...reference, attachments: hydratedReference.attachments };
    }
    return { ...message, attachments, ...(reference ? { reference } : {}) };
  }

  async probePads() {
    const sources = this.config.channels.has("pad")
      ? this.config.pad.sources
      : [];
    const statuses = await Promise.all(sources.map(probeOptSource));
    for (const status of statuses) {
      this.padStatuses.set(status.id, status);
    }
    return statuses;
  }

  async startConnectors() {
    this.connectorsStarted = true;
    this.knowledgeBase.start();
    for (const client of this.padClients) client.start();
    for (const client of this.telegramClients) client.start();
    await this.probePads();
    const recovered = this.caseManager.resumePending();
    if (recovered.queued) {
      this.logger.info("pending cases restored", recovered);
    }
    clearInterval(this.padTimer);
    this.padTimer = setInterval(
      () => void this.probePads(),
      30_000,
    );
    this.padTimer.unref?.();
  }

  async stopConnectors() {
    clearTimeout(this.settingsApplyTimer);
    this.settingsApplyTimer = null;
    clearInterval(this.padTimer);
    this.padTimer = null;
    this.knowledgeBase?.stop();
    for (const client of this.padClients) client.stop();
    for (const client of this.telegramClients) client.stop();
    this.padClients = [];
    this.telegramClients = [];
    this.caseManager?.stopAll();
  }

  listCases(options) {
    return this.caseStore.casePage(options);
  }

  caseDetail(caseId, options) {
    return this.caseStore.detail(caseId, options);
  }

  capturedMessages(options) {
    return this.caseStore.syncedMessagePage(options);
  }

  directory(options) {
    return this.caseStore.directory(options);
  }

  async syncDirectory(sourceId) {
    const sources = this.config.pad.sources.filter(
      (source) => !sourceId || source.id === sourceId,
    );
    if (!sources.length) throw new Error("gateway source not found");
    const results = [];
    for (const source of sources) {
      if (!source.accessToken) {
        throw new Error(`missing Access Code for ${source.id}`);
      }
      let lastRequestAt = 0;
      const request = async (pathname, body, label) => {
        const wait = PAD_BUSINESS_REQUEST_GAP_MS -
          (Date.now() - lastRequestAt);
        if (lastRequestAt && wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
        const response = await this.fetch(
          `${source.apiUrl.replace(/\/$/, "")}${pathname}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Access-Token": source.accessToken,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          },
        );
        const responseBody = await response.json();
        if (
          !response.ok ||
          responseBody?.Success === false ||
          responseBody?.success === false ||
          (responseBody?.Code != null && Number(responseBody.Code) !== 0)
        ) {
          throw new Error(`${label} returned HTTP ${response.status}`);
        }
        return responseBody;
      };

      const contactIds = new Set();
      let wxContactSeq = 0;
      let chatRoomSeq = 0;
      let pages = 0;
      let hasMore = false;
      while (pages < DIRECTORY_MAX_LIST_PAGES) {
        const body = await request("/v1/contacts/list", {
          currentWxcontactSeq: wxContactSeq,
          currentChatRoomContactSeq: chatRoomSeq,
        }, "contact list");
        for (const id of directoryContactIds(body)) contactIds.add(id);
        pages += 1;
        const cursor = directoryContactCursor(body);
        hasMore = cursor.continue;
        if (!hasMore) break;
        if (
          cursor.wxContactSeq === wxContactSeq &&
          cursor.chatRoomSeq === chatRoomSeq
        ) {
          throw new Error("contact list cursor did not advance");
        }
        wxContactSeq = cursor.wxContactSeq;
        chatRoomSeq = cursor.chatRoomSeq;
      }
      if (hasMore) {
        throw new Error("contact list exceeded page limit");
      }

      const existingIdentities = this.caseStore.directoryIdentities(source.id);
      const requestedIds = [...new Set([
        ...[...contactIds].filter(isDirectoryContactId),
        ...existingIdentities
          .map((entry) => entry.entity_id)
          .filter(isDirectoryContactId),
      ])];
      const entries = [];
      for (
        let index = 0;
        index < requestedIds.length;
        index += DIRECTORY_DETAIL_BATCH_SIZE
      ) {
        const batch = requestedIds.slice(
          index,
          index + DIRECTORY_DETAIL_BATCH_SIZE,
        );
        const body = await request("/v1/contacts/detail", {
          userName: batch.join(","),
        }, "contact detail");
        entries.push(...directoryEntriesFromContacts(body, source.id));
      }
      const syncedAt = Date.now();
      const syncedEntries = entries.map(
        (entry) => ({ ...entry, lastSeen: syncedAt }),
      );
      const stale = existingIdentities
        .filter((entry) => !isDirectoryContactId(entry.entity_id))
        .map((entry) => entry.entity_id);
      const removed = this.caseStore.removeDirectoryEntries(source.id, stale);
      results.push({
        sourceId: source.id,
        discovered: contactIds.size,
        requested: requestedIds.length,
        resolved: entries.length,
        named: entries.filter((entry) => entry.displayName).length,
        removed,
        imported: this.caseStore.importDirectory(syncedEntries),
      });
    }
    return {
      sources: results,
      imported: results.reduce((total, item) => total + item.imported, 0),
    };
  }

  runCase(caseId) {
    return this.caseManager.enqueue(caseId, true);
  }

  stopCase(caseId) {
    return this.caseManager.stop(caseId);
  }

  resetCaseSession(caseId) {
    return this.caseManager.resetSession(caseId);
  }

  sendDraft(caseId, draftId) {
    return this.caseManager.sendDraft(caseId, draftId);
  }

  setWorkersPaused(paused) {
    return this.caseManager.setPaused(paused);
  }

  beginWorkerDrain() {
    return this.caseManager.beginDrain();
  }

  async updateSettings(next) {
    const candidate = this.settingsStore.merged(next);
    const candidateConfig = loadConfig(this.env, candidate);
    createProvider(candidateConfig.assistant);
    const saved = await this.settingsStore.save(candidate);
    const canApplyDynamically =
      this.caseManager &&
      !this.pendingSettings &&
      connectorSignature(this.config) === connectorSignature(candidateConfig);
    if (canApplyDynamically) {
      await this.applyDynamicSettings(candidateConfig);
      return {
        settings: this.settings(),
        apply: { mode: "dynamic", reasons: [] },
      };
    }
    if (this.caseManager?.status().active > 0) {
      this.pendingSettings = saved;
      this.caseManager.beginDrain();
      this.schedulePendingSettingsApply();
      const settings = this.settingsStore.publicSettings(saved);
      settings.assistant ||= {};
      settings.assistant.workingDirectory =
        candidateConfig.assistant.workingDirectory;
      return {
        settings,
        apply: {
          mode: "controlled-drain",
          reasons: ["connector-rebuild-required"],
        },
      };
    }
    await this.applySettings(saved);
    return {
      settings: this.settings(),
      apply: {
        mode: "controlled-restart",
        reasons: ["connector-rebuild-required"],
      },
    };
  }

  async applyDynamicSettings(candidateConfig) {
    const { accessForMessage, provider } = this.providerFor(candidateConfig);
    this.config = candidateConfig;
    this.runtime.config = candidateConfig;
    this.runtime.provider = provider;
    this.caseManager.config = candidateConfig;
    this.caseManager.provider = provider;
    this.caseManager.requesterAccess = accessForMessage;
    this.padSenderClassifier.config = candidateConfig.pad;
    this.transports.hook.config = candidateConfig.hook;
    this.transports.hook.outboundMode = candidateConfig.outboundMode;
    this.transports.pad.config = candidateConfig.pad;
    this.transports.pad.outboundMode = candidateConfig.outboundMode;
    this.transports.telegram.config = candidateConfig.telegram;
    this.transports.telegram.outboundMode = candidateConfig.outboundMode;
    this.caseManager.sessionStore.maxEntries = Math.max(
      2,
      Number(candidateConfig.assistant.historyTurns || 12) * 2,
    );
    await this.knowledgeBase.reconfigure(candidateConfig.knowledgeBase, {
      started: this.connectorsStarted,
    });
  }

  schedulePendingSettingsApply() {
    if (this.settingsApplyTimer) return;
    const applyWhenIdle = async () => {
      this.settingsApplyTimer = null;
      if (!this.pendingSettings) return;
      if (this.caseManager?.status().active > 0) {
        this.settingsApplyTimer = setTimeout(applyWhenIdle, 100);
        this.settingsApplyTimer.unref?.();
        return;
      }
      const pending = this.pendingSettings;
      this.pendingSettings = null;
      try {
        await this.applySettings(pending);
        this.logger.info("deferred settings applied after workers drained");
      } catch (error) {
        this.pendingSettings = pending;
        this.logger.error("deferred settings apply failed", {
          error: error.message,
        });
      }
    };
    this.settingsApplyTimer = setTimeout(applyWhenIdle, 0);
    this.settingsApplyTimer.unref?.();
  }

  settings() {
    const settings = this.settingsStore.publicSettings(
      serializeConfig(this.config),
    );
    settings.assistant ||= {};
    settings.assistant.workingDirectory =
      this.config.assistant.workingDirectory;
    return settings;
  }

  async syncKnowledgeBase() {
    return this.knowledgeBase.sync();
  }

  agentDocument() {
    return this.workspacePolicy.read();
  }

  saveAgentDocument(content, baseHash) {
    return this.workspacePolicy.write(content, baseHash);
  }

  knowledgeDocuments() {
    return this.knowledgeBase.listDocuments();
  }

  knowledgeDocument(file) {
    return this.knowledgeBase.readDocument(file);
  }

  saveKnowledgeDocument(file, content, baseHash) {
    return this.knowledgeBase.writeDocument(file, content, { baseHash });
  }

  deleteKnowledgeDocument(file, baseHash) {
    return this.knowledgeBase.deleteDocument(file, { baseHash });
  }

  async testOpt(sourceId) {
    const source = this.config.pad.sources.find(
      (candidate) => candidate.id === sourceId,
    );
    if (!source) throw new Error(`gateway source not found: ${sourceId}`);
    const status = await probeOptSource(source);
    this.padStatuses.set(source.id, status);
    return status;
  }

  status() {
    const runtimeMode =
      process.env.WEBOT_RUNTIME_MODE ||
      (
        String(process.argv[1] || "").endsWith("/bin/webot.js")
          ? "source"
          : "sea"
      );
    const websocketStatuses = new Map(
      this.padClients.map((client) => [
        client.source.id,
        client.status(),
      ]),
    );
    const padSources = this.config.pad.sources.map((source) => {
      const websocket = websocketStatuses.get(source.id) || null;
      const health = this.padStatuses.get(source.id) || null;
      const ready = !source.enabled || Boolean(
        websocket?.connected && health?.ready,
      );
      return {
        id: source.id,
        displayName: source.displayName,
        selfId: source.selfId,
        enabled: source.enabled,
        ready,
        credentialReady: Boolean(source.accessToken),
        credentialSource: source.credentialSource,
        inboundMessages: Number(this.padIngressCounts.get(source.id) || 0),
        websocket,
        health,
      };
    });
    const enabledPadSources = this.config.channels.has("pad")
      ? padSources.filter((source) => source.enabled)
      : [];
    const padReady = !this.config.channels.has("pad") || (
      enabledPadSources.length > 0 &&
      enabledPadSources.every((source) => source.ready)
    );
    const telegramStatuses = new Map(
      this.telegramClients.map((client) => [
        client.source.id,
        client.status(),
      ]),
    );
    const telegramSources = this.config.telegram.sources.map((source) => {
      const bridge = telegramStatuses.get(source.id) || null;
      const ready = !source.enabled || Boolean(bridge?.connected);
      return {
        id: source.id,
        displayName: source.displayName,
        enabled: source.enabled,
        ready,
        credentialReady: Boolean(source.apiId && source.apiHash),
        credentialSource: source.credentialSource,
        sessionPath: source.sessionPath,
        inboundMessages: Number(
          this.telegramIngressCounts.get(source.id) || 0,
        ),
        bridge,
      };
    });
    const enabledTelegramSources = this.config.channels.has("telegram")
      ? telegramSources.filter((source) => source.enabled)
      : [];
    const telegramReady = !this.config.channels.has("telegram") || (
      enabledTelegramSources.length > 0 &&
      enabledTelegramSources.every((source) => source.ready)
    );
    const ingressReady = padReady && telegramReady;
    const configuredSources =
      enabledPadSources.length + enabledTelegramSources.length;
    const connectedSources =
      enabledPadSources.filter((source) => source.ready).length +
      enabledTelegramSources.filter((source) => source.ready).length;
    const degradedSourceIds = [
      ...enabledPadSources
        .filter((source) => !source.ready)
        .map((source) => `pad:${source.id}`),
      ...enabledTelegramSources
        .filter((source) => !source.ready)
        .map((source) => `telegram:${source.id}`),
    ];
    return {
      ok: ingressReady,
      service: "webot",
      version: process.env.WEBOT_VERSION || WEBOT_VERSION,
      runtime: {
        mode: runtimeMode,
        sourceRevision: process.env.WEBOT_SOURCE_REVISION || "",
      },
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      channels: [...this.config.channels],
      outboundMode: this.config.outboundMode,
      assistantMode: this.config.assistant.mode,
      codex: codexRuntimeStatus(this.config.assistant, this.env),
      dataDir: this.config.dataDir,
      settingsFile: path.resolve(this.settingsStore.file),
      agentFile: this.workspacePolicy.file,
      knowledgeBase: this.knowledgeBase.status(),
      cases: this.caseStore.stats(),
      workers: this.caseManager.status(),
      ingress: {
        ready: ingressReady,
        configuredSources,
        connectedSources,
        degradedSourceIds,
      },
      padSources,
      telegramSources,
    };
  }
}
