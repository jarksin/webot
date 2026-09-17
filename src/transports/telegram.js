import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { normalizeTelegramBridgeEvent } from "../normalize.js";
import { telegramSourceForMessage } from "../telegram-sources.js";

const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function replyMessageId(message = {}) {
  const value = Number(message.telegramMessageId || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export class TelegramTransport {
  constructor(config, outboundMode, logger = console) {
    this.config = config;
    this.outboundMode = outboundMode;
    this.logger = logger;
    this.clients = new Map();
  }

  setClients(clients) {
    this.clients = new Map(
      (clients || []).map((client) => [client.source.id, client]),
    );
  }

  source(message = {}) {
    const source = telegramSourceForMessage(
      { telegram: this.config },
      message,
    );
    if (!source) {
      throw new Error(
        `Telegram source is not configured: ${message.sourceId || "<empty>"}`,
      );
    }
    return source;
  }

  client(message = {}) {
    const source = this.source(message);
    const client = this.clients.get(source.id);
    if (!client) {
      throw new Error(`Telegram source is unavailable: ${source.id}`);
    }
    return client;
  }

  async send(message, text) {
    const source = this.source(message);
    if (this.outboundMode !== "live") {
      this.logger.info("telegram outbound dry-run", {
        sourceId: source.id,
        chatId: message.chatId,
        bytes: Buffer.byteLength(String(text || "")),
      });
      return { ok: true, dryRun: true };
    }
    const result = await this.client(message).request({
      action: "send_message",
      chat_id: message.replyTarget || message.chatId,
      text: String(text || ""),
      reply_to: message.chatType === "group"
        ? replyMessageId(message)
        : undefined,
    });
    return { ok: true, result };
  }

  async sendArtifact(message, artifact) {
    const source = this.source(message);
    const filePath = String(artifact?.path || "");
    if (!filePath || !fs.statSync(filePath).isFile()) {
      throw new Error("Telegram attachment path is not a file");
    }
    if (this.outboundMode !== "live") {
      this.logger.info("telegram attachment dry-run", {
        sourceId: source.id,
        chatId: message.chatId,
        path: filePath,
      });
      return { ok: true, dryRun: true };
    }
    const result = await this.client(message).request({
      action: "send_file",
      chat_id: message.replyTarget || message.chatId,
      path: filePath,
      reply_to: message.chatType === "group"
        ? replyMessageId(message)
        : undefined,
    }, 180_000);
    return { ok: true, result };
  }
}

export class TelegramBridgeClient {
  constructor(
    source,
    onMessage,
    logger = console,
    options = {},
  ) {
    this.source = source;
    this.onMessage = onMessage;
    this.logger = logger;
    this.spawn = options.spawnImpl || spawn;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.reconnectTimer = null;
    this.stopped = true;
    this.ready = false;
    this.connectedAt = 0;
    this.lastMessageAt = 0;
    this.lastError = "";
    this.reconnects = 0;
    this.selfId = "";
  }

  start() {
    if (!this.stopped || this.child) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.child) return;
    this.ready = false;
    this.lastError = "";
    const args = [
      "-u",
      this.source.bridgeScript,
      "--session",
      this.source.sessionPath,
      this.source.listenSelf ? "--listen-self" : "--no-listen-self",
    ];
    const child = this.spawn(this.source.pythonBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TG_API_ID: this.source.apiId,
        TG_API_HASH: this.source.apiHash,
        TG_SESSION_PATH: this.source.sessionPath,
      },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => {
      const detail = String(chunk || "").trim().slice(-1000);
      if (detail) {
        this.logger.warn("telegram bridge stderr", {
          sourceId: this.source.id,
          detail,
        });
      }
    });
    child.once("error", (error) => this.disconnected(error));
    child.once("close", (code, signal) => {
      this.disconnected(
        new Error(
          `Telegram bridge exited (${code ?? "null"}${
            signal ? `, ${signal}` : ""
          })`,
        ),
      );
    });
  }

  consume(chunk) {
    this.buffer += String(chunk || "");
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      const child = this.child;
      this.disconnected(new Error("Telegram bridge line exceeds 1 MiB"));
      child?.kill("SIGTERM");
      return;
    }
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handle(JSON.parse(line));
      } catch (error) {
        this.logger.warn("invalid telegram bridge event", {
          sourceId: this.source.id,
          error: error.message,
        });
      }
    }
  }

  handle(event) {
    if (event?.type === "ready") {
      this.ready = true;
      this.connectedAt = Date.now();
      this.lastError = "";
      this.selfId = String(event.self_id || "");
      this.logger.info("telegram bridge ready", {
        sourceId: this.source.id,
        accountType: event.account_type || "unknown",
      });
      return;
    }
    if (event?.type === "response") {
      const pending = this.pending.get(String(event.id || ""));
      if (!pending) return;
      this.pending.delete(String(event.id));
      clearTimeout(pending.timer);
      if (event.ok) pending.resolve(event);
      else pending.reject(new Error(event.error || "Telegram request failed"));
      return;
    }
    if (event?.type === "fatal") {
      this.lastError = String(event.error || "Telegram bridge failed");
      return;
    }
    if (event?.type !== "message") return;
    const message = normalizeTelegramBridgeEvent(event, this.source);
    if (!message) return;
    this.lastMessageAt = Date.now();
    Promise.resolve(this.onMessage(message)).catch((error) => {
      this.logger.error("telegram inbound failed", {
        sourceId: this.source.id,
        error: error.message,
      });
    });
  }

  request(payload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!this.child || !this.ready || !this.child.stdin.writable) {
      return Promise.reject(new Error("Telegram bridge is not ready"));
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Telegram request timed out"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  disconnected(error) {
    if (!this.child && this.stopped) return;
    this.child = null;
    this.ready = false;
    this.buffer = "";
    this.lastError = String(error?.message || error || "");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Telegram bridge disconnected"));
    }
    this.pending.clear();
    if (this.stopped || this.reconnectTimer) return;
    this.reconnects += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnects, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Telegram bridge stopped"));
    }
    this.pending.clear();
  }

  status() {
    return {
      sourceId: this.source.id,
      connected: Boolean(this.child && this.ready),
      connectionState: this.stopped
        ? "stopped"
        : this.ready
          ? "connected"
          : "connecting",
      connectedAt: this.connectedAt || null,
      lastMessageAt: this.lastMessageAt || null,
      lastError: this.lastError,
      reconnects: this.reconnects,
      selfId: this.selfId,
    };
  }
}
