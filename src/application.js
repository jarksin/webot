import path from "node:path";
import { CaseManager } from "./case-manager.js";
import { CaseStore } from "./case-store.js";
import { directoryEntriesFromContacts } from "./contact-directory.js";
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
import { WorkspacePolicy } from "./workspace-policy.js";
import { HookTransport } from "./transports/hook.js";
import {
  PadTransport,
  PadWebSocketClient,
} from "./transports/pad.js";
import { WEBOT_VERSION } from "./version.js";

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
    this.padStatuses = new Map();
    this.padIngressCounts = new Map();
    this.padSenderClassifier = null;
    this.padTimer = null;
    this.caseStore = null;
    this.caseManager = null;
    this.workspacePolicy = null;
    this.connectorsStarted = false;
    this.startedAt = Date.now();
    this.sourceActivator = createSourceActivator({ env });
    this.fetch = fetchImpl;
  }

  async initialize() {
    const settings = await this.settingsStore.load();
    await this.applySettings(settings);
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
    const accessForMessage = (message) =>
      requesterAccess(message, this.config.policy.ownerSenderIds);
    const provider = createProvider(this.config.assistant, {
      requesterAccess: accessForMessage,
      searchKnowledge: (query, context) =>
        this.knowledgeBase.search(query, context),
      readAgentPolicy: () => this.workspacePolicy.read(),
    });
    const store = new SessionStore(
      this.config.stateDir,
      this.config.assistant.historyTurns,
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
      ),
    };
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
    if (this.connectorsStarted) await this.startConnectors();
  }

  async receive(message) {
    if (message.transport === "pad") {
      const key = message.sourceId || "default";
      this.padIngressCounts.set(
        key,
        Number(this.padIngressCounts.get(key) || 0) + 1,
      );
      this.caseStore.observeIdentity(message);
      const classification = await this.padSenderClassifier.classify(message);
      if (classification.blocked) {
        return { accepted: false, reason: classification.reason };
      }
    }
    return this.caseManager.receive(message);
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
    clearInterval(this.padTimer);
    this.padTimer = null;
    this.knowledgeBase?.stop();
    for (const client of this.padClients) client.stop();
    this.padClients = [];
    this.caseManager?.stopAll();
  }

  listCases(options) {
    return this.caseStore.casePage(options);
  }

  caseDetail(caseId, options) {
    return this.caseStore.detail(caseId, options);
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
      const response = await this.fetch(
        `${source.apiUrl.replace(/\/$/, "")}/v1/contacts/list`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Access-Token": source.accessToken,
          },
          body: "{}",
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = await response.json();
      if (
        !response.ok ||
        body?.Success === false ||
        body?.success === false ||
        (body?.Code != null && Number(body.Code) !== 0)
      ) {
        throw new Error(`contact list returned HTTP ${response.status}`);
      }
      const syncedAt = Date.now();
      const entries = directoryEntriesFromContacts(body, source.id).map(
        (entry) => ({ ...entry, lastSeen: syncedAt }),
      );
      results.push({
        sourceId: source.id,
        imported: this.caseStore.importDirectory(entries),
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
    await this.applySettings(saved);
    return this.settings();
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
    const ingressReady = !this.config.channels.has("pad") || (
      enabledPadSources.length > 0 &&
      enabledPadSources.every((source) => source.ready)
    );
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
        configuredSources: enabledPadSources.length,
        connectedSources: enabledPadSources.filter(
          (source) => source.ready,
        ).length,
        degradedSourceIds: enabledPadSources
          .filter((source) => !source.ready)
          .map((source) => source.id),
      },
      padSources,
    };
  }
}
