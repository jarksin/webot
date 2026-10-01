import path from "node:path";
import { markHydratedImage } from "./inbound-images.js";
import { acceptedMessage } from "./runtime.js";
import {
  applyControlCommand,
  parseControlCommand,
  runtimeOverrides,
} from "./control-commands.js";
import { assistantConfigForMessage } from "./assistant-routing.js";
import { parseAssistantResult } from "./codex-provider.js";

function acceptsOwnerIntermediateItems(message) {
  return Boolean(
    message?.chatType === "private" &&
      message.selfConversation === true &&
      (
        (
          message.transport === "pad" &&
          (message.selfPeer === true || message.exactSelfChat === true)
        ) ||
        (
          message.transport === "telegram" &&
          message.exactSelfChat === true
        )
      ),
  );
}

function oversizedAttachmentFailure(error) {
  return Boolean(
    error?.code === "WEBOT_ATTACHMENT_TOO_LARGE" ||
      /(?:at most|exceeds?) 64 MiB/i.test(String(error?.message || error)),
  );
}

function commandNeedsIdleWorker(command) {
  return command?.type === "clear" || command?.type === "stop";
}

function completedDraftText(text) {
  const value = String(text || "").trim();
  return /^\[done\](?:\s|$)/i.test(value) ? value : `[done] ${value}`;
}

function normalizedProviderResult(value) {
  const result = typeof value === "string"
    ? { text: value }
    : value && typeof value === "object"
      ? value
      : {};
  const parsed = parseAssistantResult(result.text);
  return {
    ...result,
    text: parsed.text,
    artifacts: Array.isArray(result.artifacts)
      ? result.artifacts
      : parsed.artifacts,
    noReply: result.noReply === true || parsed.noReply === true,
  };
}

export function transientProviderFailure(error) {
  const text = String(error?.message || error || "");
  if (/\bcodex_config_changed\b|\b409\s+Conflict\b/i.test(text)) return false;
  if (/usage limit|rate limit|quota|insufficient_quota/i.test(text)) return false;
  return /stream disconnected|error decoding response body|transport error:\s*network error|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)\b|socket hang up|\b(?:502|503|504)\b|service unavailable|bad gateway|gateway timeout|auth_unavailable/i.test(text);
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new Error("worker stopped"));
  const delay = Math.max(0, Number(delayMs || 0));
  if (!delay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new Error("worker stopped"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export class CaseManager {
  constructor({
    config,
    provider,
    sessionStore,
    caseStore,
    transports,
    requesterAccess = () => "public",
    hydratePadMedia = async (message) => message,
    afterOwnerRun = null,
    logger = console,
  }) {
    this.config = config;
    this.provider = provider;
    this.sessionStore = sessionStore;
    this.caseStore = caseStore;
    this.transports = transports;
    this.requesterAccess = requesterAccess;
    this.hydratePadMedia = hydratePadMedia;
    this.afterOwnerRun =
      typeof afterOwnerRun === "function" ? afterOwnerRun : null;
    this.logger = logger;
    this.running = new Map();
    this.runPromises = new Map();
    this.queue = [];
    this.rerun = new Set();
    this.forced = new Set();
    this.active = 0;
    this.draining = false;
    this.idleDrain = null;
  }

  paused() {
    return this.caseStore.runtimeSetting("workers_paused", "0") === "1";
  }

  setPaused(value) {
    this.caseStore.setRuntimeSetting("workers_paused", value ? "1" : "0");
    if (!value) this.drain();
    return this.paused();
  }

  beginDrain() {
    if (this.idleDrain) this.idleDrain.release(false);
    this.draining = true;
    return this.status();
  }

  idle() {
    return this.active === 0 && this.queue.length === 0 &&
      this.rerun.size === 0 && !this.draining;
  }

  reserveIdle({ leaseMs = 60_000, schedule = setTimeout, cancel = clearTimeout } = {}) {
    if (this.idleDrain) {
      if (this.active > 0 || this.queue.length || this.rerun.size) {
        this.idleDrain.release();
        return null;
      }
      this.idleDrain.renew();
      return this.idleDrain;
    }
    if (!this.idle()) return null;
    let timer;
    const reservation = {
      renew: () => {
        cancel(timer);
        timer = schedule(reservation.release, leaseMs);
        timer.unref?.();
      },
      release: (resume = true) => {
        if (this.idleDrain !== reservation) return;
        cancel(timer);
        this.idleDrain = null;
        this.draining = false;
        if (resume) this.drain();
      },
    };
    this.idleDrain = reservation;
    this.draining = true;
    reservation.renew();
    return reservation;
  }

  caseSettings() {
    return this.config.caseManagement || {};
  }

  outputSessionName(caseId) {
    const run = this.running.get(caseId);
    return run?.labelOutputs ? run.sessionName : "";
  }

  sessionOutputText(caseId, text, name = this.outputSessionName(caseId)) {
    return name ? `[${name}] ${text}` : text;
  }

  groupContextSettings() {
    const settings = this.caseSettings();
    return {
      limit: Number(settings.groupContextLimit ?? 50),
      retentionHours: Number(settings.groupContextRetentionHours ?? 168),
      maxMessages: Number(settings.groupContextMaxMessages ?? 2000),
    };
  }

  async hydrateTelegramMedia(message) {
    if (message?.transport === "pad") return this.hydratePadMedia(message);
    if (message?.transport !== "telegram") return message;
    const attachments = Array.isArray(message?.attachments)
      ? [...message.attachments]
      : [];
    const transport = this.transports.telegram;
    if (!transport || typeof transport.downloadInboundAttachment !== "function") {
      return message;
    }
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (
        attachment?.kind !== "image" ||
        !attachment?.downloadContext?.type
      ) continue;
      try {
        const cached = await transport.downloadInboundAttachment(
          message,
          attachment,
          this.config.dataDir,
        );
        attachments[index] = markHydratedImage(attachment, cached);
      } catch (error) {
        attachments[index] = {
          ...attachment,
          error: String(error.message || error),
        };
        this.logger.warn("telegram inbound image cache failed", {
          sourceId: message.sourceId,
          messageId: message.messageId,
          error: error.message,
        });
      }
    }
    let reference = message.reference;
    if (reference && Array.isArray(reference.attachments)) {
      const hydratedReference = await this.hydrateTelegramMedia({
        ...message,
        messageId: reference.messageId || message.messageId,
        telegramMessageId: reference.telegramMessageId || message.telegramMessageId,
        attachments: reference.attachments,
        reference: null,
      });
      reference = { ...reference, attachments: hydratedReference.attachments };
    }
    return { ...message, attachments, ...(reference ? { reference } : {}) };
  }

  async hydrateTelegramMediaContext(entries) {
    const result = [];
    for (const entry of entries || []) {
      result.push({
        ...entry,
        message: await this.hydrateTelegramMedia(entry.message || {}),
      });
    }
    return result;
  }

  async receive(message) {
    const decision = acceptedMessage(message, this.config);
    if (decision.retainGroupContext || (
      decision.accepted && message.chatType === "group"
    )) {
      const context = this.caseStore.ingestGroupContext(
        message,
        this.groupContextSettings(),
      );
      if (!decision.accepted) {
        return {
          ...decision,
          contextStored: context.inserted,
        };
      }
    }
    if (!decision.accepted) return decision;
    const clean = { ...message, text: decision.text || message.text };
    const owner = this.requesterAccess(clean) === "owner";
    const command = owner ? parseControlCommand(clean.text) : null;
    const ingested = this.caseStore.ingest(clean, clean.text, {
      useActiveSession: owner,
    });
    if (!ingested.inserted) {
      return { accepted: false, reason: "duplicate", caseId: ingested.caseId };
    }
    if (command) {
      let stopped = false;
      if (command.type === "stop") stopped = this.stop(ingested.caseId);
      if (commandNeedsIdleWorker(command)) {
        const active = this.runPromises.get(ingested.caseId);
        if (active) await active.catch(() => {});
      }
      const result = await applyControlCommand({
        command,
        caseId: ingested.caseId,
        scopeCaseId: ingested.scopeCaseId,
        caseStore: this.caseStore,
        sessionStore: this.sessionStore,
        config: assistantConfigForMessage(this.config.assistant, clean),
        stopped,
      });
      if (result.continueText) {
        clean.text = result.continueText;
        this.caseStore.updateMessageText(
          ingested.caseId,
          ingested.messageRow,
          result.continueText,
        );
        clean.deferToNextRun = true;
      } else {
        const reply = String(result.text || "").trim();
        this.caseStore.markControlHandled(ingested.caseId, ingested.messageRow);
        const draftId = this.caseStore.addDraft(
          ingested.caseId,
          reply,
          result.model || runtimeOverrides(
            this.caseStore,
            ingested.caseId,
          ).model ||
            assistantConfigForMessage(this.config.assistant, clean).codexModel,
          {
            triggerMessageId: ingested.messageRow,
            inputCutoffMessageId: ingested.messageRow,
            outputSessionName: this.outputSessionName(ingested.caseId),
          },
        );
        this.caseStore.addProgress(
          ingested.caseId,
          0,
          `控制命令已处理，draft #${draftId} 已生成`,
        );
        if (this.caseSettings().autoSend !== false) {
          await this.sendDraft(ingested.caseId, draftId);
        }
        return {
          accepted: true,
          caseId: ingested.caseId,
          queued: false,
          command: command.type,
        };
      }
    }
    await this.sessionStore.append(ingested.caseId, "user", clean.text);
    if (this.caseSettings().autoRun !== false) {
      const activeRun = this.running.get(ingested.caseId);
      let steered = false;
      if (
        activeRun &&
        !this.rerun.has(ingested.caseId) &&
        !clean.deferToNextRun &&
        !clean.attachments?.length &&
        !clean.reference &&
        typeof this.provider.steer === "function"
      ) {
        const result = await this.provider.steer({
          caseId: ingested.caseId,
          text: clean.text,
          messageId: String(ingested.messageRow),
        });
        if (result?.accepted) {
          activeRun.includeMessage(ingested.messageRow);
          steered = true;
          this.caseStore.addProgress(
            ingested.caseId,
            0,
            "新消息已补充到当前 Codex turn",
          );
        } else if (result?.error) {
          this.caseStore.addProgress(
            ingested.caseId,
            0,
            `当前 Codex turn 未接受补充，改为后续处理：${result.error}`,
            "warn",
          );
        }
      }
      if (activeRun && !steered) {
        this.rerun.add(ingested.caseId);
        this.caseStore.addProgress(
          ingested.caseId,
          0,
          "收到新消息，当前 worker 完成后继续处理",
        );
      } else {
        if (!activeRun) this.enqueue(ingested.caseId);
      }
      if (steered) {
        return {
          accepted: true,
          caseId: ingested.caseId,
          queued: false,
          steered: true,
        };
      }
    }
    return {
      accepted: true,
      caseId: ingested.caseId,
      queued: this.caseSettings().autoRun !== false,
    };
  }

  enqueue(caseId, force = false) {
    if (!this.caseStore.caseRow(caseId)) throw new Error("case not found");
    if (this.running.has(caseId) || this.queue.includes(caseId)) {
      return { queued: false, reason: "already-queued" };
    }
    if (force) this.forced.add(caseId);
    this.queue.push(caseId);
    this.caseStore.addProgress(caseId, 0, force ? "人工触发 worker" : "Case 已进入 worker 队列");
    this.drain();
    return { queued: true };
  }

  resumePending() {
    if (this.caseSettings().autoRun === false || this.paused()) {
      return { queued: 0 };
    }
    let queued = 0;
    for (const caseId of this.caseStore.pendingCaseIds()) {
      const result = this.enqueue(caseId);
      if (result.queued) queued += 1;
    }
    return { queued };
  }

  drain() {
    if (this.paused() || this.draining) return;
    const concurrency = Math.max(
      1,
      Math.min(Number(this.caseSettings().workerConcurrency || 2), 8),
    );
    while (this.active < concurrency && this.queue.length) {
      const caseId = this.queue.shift();
      this.active += 1;
      const operation = this.run(caseId)
        .catch((error) => {
          this.logger.error("case worker failed", {
            caseId,
            error: error.message,
          });
        })
        .finally(() => {
          this.runPromises.delete(caseId);
          this.active -= 1;
          this.drain();
        });
      this.runPromises.set(caseId, operation);
    }
  }

  async run(caseId) {
    if (this.running.has(caseId)) return;
    const previousSession = this.caseStore.workerSession(caseId);
    const force = this.forced.delete(caseId);
    let pending = this.caseStore.pendingMessages(
      caseId,
      previousSession?.last_processed_message_id || 0,
    );
    if (!pending.length && force) {
      const latest = this.caseStore.latestMessage(caseId);
      if (latest) pending = [latest];
    }
    if (!pending.length) return;
    const trigger = pending[pending.length - 1];
    const previousMessage = previousSession?.last_processed_message_id
      ? this.caseStore.messageByRowId(
          caseId,
          previousSession.last_processed_message_id,
        )
      : null;
    const cutoffMessageId = trigger.id;
    let completionCutoffMessageId = cutoffMessageId;
    let replyTargetMessageId = trigger.id;
    const session = this.caseStore.startRun(caseId, cutoffMessageId);
    const controller = new AbortController();
    const namedSession = this.caseStore.sessionForTarget(caseId);
    this.running.set(caseId, {
      controller,
      sessionScopeCaseId: namedSession?.scope_case_id || caseId,
      sessionName: namedSession?.name || "main",
      labelOutputs: false,
      includeMessage(messageRow) {
        const id = Number(messageRow || 0);
        if (!id) return;
        completionCutoffMessageId = Math.max(completionCutoffMessageId, id);
        replyTargetMessageId = Math.max(replyTargetMessageId, id);
      },
    });
    const currentRun = this.running.get(caseId);
    // Retain labels through completion, even after an overlapping run finishes.
    for (const [otherCaseId, otherRun] of this.running) {
      if (
        otherCaseId !== caseId &&
        otherRun.sessionScopeCaseId === currentRun.sessionScopeCaseId
      ) {
        currentRun.labelOutputs = true;
        otherRun.labelOutputs = true;
      }
    }
    this.caseStore.addProgress(caseId, session.run_count, "worker 开始处理");
    const liveProgressSeen = new Set();
    const onItem = async (item) => {
      if (item?.type !== "agent_message") return;
      const text = String(item.text || "").trim();
      if (!text || liveProgressSeen.has(text)) return;
      liveProgressSeen.add(text);
      this.caseStore.addProgress(
        caseId,
        session.run_count,
        text,
        "live",
      );
      if (this.caseSettings().ownerIntermediateItems !== true) return;
      if (this.requesterAccess(trigger.message) !== "owner") return;
      if (!acceptsOwnerIntermediateItems(trigger.message)) return;
      const transport = this.transports[trigger.message.transport];
      if (!transport) return;
      try {
        const outbound = await transport.send(
          trigger.message,
          this.sessionOutputText(caseId, text),
        );
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          outbound.dryRun ? "中间回复演练发送完成" : "中间回复已发送",
        );
      } catch (error) {
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          `中间回复发送失败：${error.message}`,
          "warn",
        );
        this.logger.warn("intermediate item send failed", {
          caseId,
          error: error.message,
        });
      }
    };
    try {
      const history = await this.sessionStore.history(caseId);
      const currentText = pending
        .map((item) => String(item.text || item.message?.text || "").trim())
        .filter(Boolean)
        .join("\n");
      const mediaContext = await this.hydrateTelegramMediaContext(
        this.caseStore.mediaContextBefore(trigger.message, {
          excludeMessageIds: pending.map((item) => item.message_id),
        }),
      );
      const hydratedPending = await this.hydrateTelegramMediaContext(pending);
      const pendingAttachments = hydratedPending.flatMap((item) =>
        Array.isArray(item.message?.attachments) ? item.message.attachments : []
      );
      const currentMessage = {
        ...hydratedPending.at(-1).message,
        text: currentText || trigger.message.text,
        attachments: pendingAttachments.length
          ? pendingAttachments
          : trigger.message.attachments,
      };
      const conversationContext = this.caseStore.groupContextBefore(
        trigger.message,
        {
          ...this.groupContextSettings(),
          afterMessageId: previousMessage?.message_id || "",
          excludeMessageIds: pending.map((item) => item.message_id),
        },
      );
      this.caseStore.addProgress(caseId, session.run_count, "正在生成 draft");
      const providerRequest = {
        caseId,
        codexSessionId: session.codex_session_id || "",
        message: currentMessage,
        history,
        conversationContext,
        mediaContext,
        currentMessageCount: pending.length,
        signal: controller.signal,
        onItem,
        runtimeOverrides: runtimeOverrides(this.caseStore, caseId),
      };
      const maxTransientRetries = Math.max(
        0,
        Number(this.caseSettings().providerTransientRetryMax ?? 1),
      );
      let transientRetryCount = 0;
      let providerResult;
      for (;;) {
        try {
          providerResult = await this.provider.reply(providerRequest);
          break;
        } catch (error) {
          if (
            controller.signal.aborted ||
            !transientProviderFailure(error) ||
            transientRetryCount >= maxTransientRetries
          ) {
            throw error;
          }
          transientRetryCount += 1;
          const delayMs = Math.max(
            0,
            Number(this.caseSettings().providerTransientRetryDelayMs ?? 1500),
          );
          this.caseStore.addProgress(
            caseId,
            session.run_count,
            `Codex 瞬态连接失败，自动重试 ${transientRetryCount}/${maxTransientRetries}：${error.message}`,
            "warn",
          );
          await waitForRetry(delayMs, controller.signal);
        }
      }
      const result = normalizedProviderResult(providerResult);
      const reply = String(result?.text || "").trim();
      const owner = this.requesterAccess(trigger.message) === "owner";
      const artifacts = owner && Array.isArray(result?.artifacts)
        ? result.artifacts
        : [];
      const explicitNoReply =
        result?.noReply === true &&
        !reply &&
        artifacts.length === 0;
      if (!reply && !explicitNoReply) {
        throw new Error("assistant returned no text");
      }
      if (!owner && result?.artifacts?.length) {
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          "已忽略非 owner 请求中的本地附件",
          "warn",
        );
      }
      if (controller.signal.aborted) throw new Error("worker stopped");
      this.caseStore.recordProviderResult(caseId, result);
      if (explicitNoReply) {
        this.caseStore.addProgress(
          caseId,
          session.run_count,
          "assistant 明确选择静默，本轮不生成或发送回复",
        );
        this.caseStore.finishRun(
          caseId,
          "replied",
          "",
          completionCutoffMessageId,
        );
      } else {
        const draftId = this.caseStore.addDraft(
          caseId,
          reply,
          result.model ||
            assistantConfigForMessage(
              this.config.assistant,
              currentMessage,
            ).codexModel ||
            this.config.assistant.llmModel ||
            this.config.assistant.mode,
          {
            triggerMessageId: replyTargetMessageId,
            inputCutoffMessageId: completionCutoffMessageId,
            artifacts,
            outputSessionName: this.outputSessionName(caseId),
          },
        );
        await this.sessionStore.append(caseId, "assistant", reply);
        this.caseStore.addProgress(caseId, session.run_count, `draft #${draftId} 已生成`);
        this.caseStore.finishRun(
          caseId,
          "draft_ready",
          "",
          completionCutoffMessageId,
        );
        if (this.caseSettings().autoSend !== false) {
          try {
            await this.sendDraft(caseId, draftId);
          } catch (error) {
            this.caseStore.markDraftError(caseId, draftId, error.message);
            this.caseStore.finishRun(
              caseId,
              "draft_ready",
              error.message,
              completionCutoffMessageId,
            );
            this.caseStore.addProgress(
              caseId,
              session.run_count,
              `draft #${draftId} 自动发送失败，已保留待重试：${error.message}`,
              "warn",
            );
          }
        }
      }
      if (owner && this.afterOwnerRun) {
        try {
          const activation = await this.afterOwnerRun({
            caseId,
            message: currentMessage,
            sourceId: currentMessage.sourceId,
          });
          if (activation?.requested) {
            this.caseStore.addProgress(
              caseId,
              session.run_count,
              `已提交 Webot v${activation.version} 受控激活请求`,
            );
          } else if (activation?.reason === "waiting-for-idle" ||
                     activation?.reason === "waiting-for-ingress") {
            this.caseStore.addProgress(
              caseId,
              session.run_count,
              activation.reason === "waiting-for-idle"
                ? "Webot 激活等待任务空闲，新任务继续正常调度"
                : "Webot 激活等待连接配置应用和入站健康恢复",
            );
          }
        } catch (error) {
          this.caseStore.addProgress(
            caseId,
            session.run_count,
            `Webot 受控激活请求失败：${error.message}`,
            "warn",
          );
          this.logger.warn("source activation request failed", {
            caseId,
            error: error.message,
          });
        }
      }
    } catch (error) {
      const stopped = controller.signal.aborted;
      const status = stopped ? "stopped" : "failed";
      this.caseStore.addProgress(
        caseId,
        session.run_count,
        stopped ? "worker 已停止" : `worker 失败：${error.message}`,
        stopped ? "warn" : "error",
      );
      this.caseStore.finishRun(caseId, status, error.message);
      if (!stopped) throw error;
    } finally {
      this.running.delete(caseId);
      if (this.rerun.delete(caseId)) this.enqueue(caseId);
    }
  }

  async sendDraft(caseId, draftId) {
    return this.sendDraftWithOptions(caseId, draftId);
  }

  async sendDraftWithOptions(caseId, draftId, options = {}) {
    const draft = this.caseStore.draft(caseId, draftId);
    if (!draft) throw new Error("draft not found");
    if (draft.status === "sent") return { alreadySent: true };
    const target = draft.trigger_message_id
      ? this.caseStore.messageByRowId(caseId, draft.trigger_message_id)
      : this.caseStore.latestMessage(caseId);
    if (!target) throw new Error("case has no reply target");
    const transport = this.transports[target.message.transport];
    if (!transport) throw new Error("reply transport is unavailable");
    const artifactOutbounds = [];
    for (const artifact of draft.artifacts || []) {
      if (typeof transport.sendArtifact !== "function") {
        throw new Error("reply transport cannot send attachments");
      }
      try {
        artifactOutbounds.push(
          await transport.sendArtifact(target.message, artifact),
        );
      } catch (error) {
        error.artifact ||= artifact;
        if (
          options.allowOversizeFallback !== false &&
          oversizedAttachmentFailure(error) &&
          this.requesterAccess(target.message) === "owner"
        ) {
          try {
            const filename = path.basename(String(
              artifact.filename || artifact.path || "文件",
            ));
            const fallbackText = target.message.transport === "telegram"
              ? `文件 ${filename} 太大，当前 Telegram 发送失败，请手动发送。`
              : `文件 ${filename} 超过微信 64 MiB 限制，包太大无法发送，请手动发送。`;
            const fallbackDraftId = this.caseStore.addDraft(
              caseId,
              fallbackText,
              draft.model,
              {
                triggerMessageId: draft.trigger_message_id,
                inputCutoffMessageId: draft.input_cutoff_message_id,
                outputSessionName:
                  draft.output_session_name || this.outputSessionName(caseId),
              },
            );
            await this.sendDraftWithOptions(caseId, fallbackDraftId, {
              allowOversizeFallback: false,
            });
            error.fallbackDraftId = fallbackDraftId;
            error.fallbackSent = true;
          } catch (fallbackError) {
            error.fallbackError = fallbackError;
          }
        }
        throw error;
      }
    }
    const markCompleted = (
      this.caseSettings().ownerIntermediateItems === true &&
      this.requesterAccess(target.message) === "owner" &&
      acceptsOwnerIntermediateItems(target.message) &&
      !parseControlCommand(target.message.text)
    );
    const textOutbound = await transport.send(
      target.message,
      this.sessionOutputText(
        caseId,
        markCompleted ? completedDraftText(draft.text) : draft.text,
        draft.output_session_name || this.outputSessionName(caseId),
      ),
    );
    const outbound = {
      ok: true,
      dryRun:
        Boolean(textOutbound?.dryRun) &&
        artifactOutbounds.every((item) => item?.dryRun),
      text: textOutbound,
      artifacts: artifactOutbounds,
    };
    this.caseStore.markSent(caseId, draftId, outbound);
    this.caseStore.addProgress(
      caseId,
      0,
      outbound.dryRun ? `draft #${draftId} 演练发送完成` : `draft #${draftId} 已发送`,
    );
    return outbound;
  }

  stop(caseId) {
    this.queue = this.queue.filter((queuedCaseId) => queuedCaseId !== caseId);
    this.rerun.delete(caseId);
    this.forced.delete(caseId);
    const controller = this.running.get(caseId);
    if (!controller) return false;
    controller.controller.abort();
    return true;
  }

  resetSession(caseId) {
    if (this.running.has(caseId)) {
      throw new Error("cannot reset a running case");
    }
    return this.caseStore.resetCodexSession(caseId);
  }

  stopAll() {
    // A discarded manager must not later resume from an old restart lease.
    this.queue = [];
    this.rerun.clear();
    this.forced.clear();
    this.idleDrain?.release();
    for (const run of this.running.values()) run.controller.abort();
  }

  status() {
    return {
      paused: this.paused(),
      draining: this.draining,
      active: this.active,
      queued: this.queue.length + this.rerun.size,
      runningCaseIds: [...this.running.keys()],
    };
  }
}
