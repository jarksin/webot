import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { sourceForMessage } from "../ingress-sources.js";
import { normalizePadEnvelope } from "../normalize.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const AUDIO_FORMATS = new Map([
  [".amr", 0],
  [".spx", 1],
  [".speex", 1],
  [".mp3", 2],
  [".wav", 3],
  [".wave", 3],
  [".silk", 4],
]);
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const WEBSOCKET_OPEN = 1;
const MAX_INBOUND_IMAGE_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function tokenHeaders(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { "X-Access-Token": token } : {}),
  };
}

function padSucceeded(response, body) {
  if (!response.ok) return false;
  if (body.Success === false || body.success === false) return false;
  const code = body.Code ?? body.code;
  if (code != null && Number(code) !== 0) return false;
  const baseRet =
    body.BaseResponse?.Ret ??
    body.base_response?.ret ??
    body.Data?.BaseResponse?.Ret;
  if (baseRet != null && Number(baseRet) !== 0) return false;
  return true;
}

function padFailureDetail(body) {
  return String(
    body?.error ||
    body?.message ||
    body?.Message ||
    body?.msg ||
    "",
  ).trim();
}

function padEndpointURL(source, endpoint) {
  const base = String(source.apiUrl || "").replace(/\/$/, "");
  let pathname = String(endpoint || "").trim();
  if (base.endsWith("/api") && pathname.startsWith("/api/")) {
    pathname = pathname.slice(4);
  }
  return `${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function inboundImageType(data) {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { extension: ".jpg", mime: "image/jpeg" };
  }
  if (data.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))) {
    return { extension: ".png", mime: "image/png" };
  }
  if (data.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
    return { extension: ".gif", mime: "image/gif" };
  }
  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", mime: "image/webp" };
  }
  return { extension: ".img", mime: "application/octet-stream" };
}

function safeFileSegment(value, fallback) {
  const segment = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return segment || fallback;
}

async function probeAudioDurationMs(filePath, artifact = {}) {
  const supplied = Number(artifact.durationMs || artifact.duration_ms || 0);
  if (supplied > 0 && supplied <= 600_000) return Math.ceil(supplied);

  const candidates = [
    process.env.WEBOT_FFPROBE_BIN,
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "ffprobe",
  ].filter((candidate, index, values) =>
    candidate && values.indexOf(candidate) === index
  );
  let lastError;
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      const durationMs = Math.ceil(Number.parseFloat(stdout) * 1000);
      if (durationMs > 0 && durationMs <= 600_000) return durationMs;
      lastError = new Error("audio duration is outside the WeChat voice limit");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `cannot determine audio duration for WeChat voice delivery: ${
      lastError?.message || "ffprobe unavailable"
    }`,
  );
}

function stripAiReplyPrefix(text) {
  return String(text || "").replace(
    /^\s*【AI(?:\s+\d+\/\d+)?】\s*/i,
    "",
  );
}

export function isSameAccountPrivateReply(message = {}, source = {}) {
  if (message.chatType === "group") return false;
  const replyTarget = String(
    message.replyTarget || message.chatId || "",
  ).trim().toLowerCase();
  const selfId = String(source.selfId || message.selfId || "")
    .trim()
    .toLowerCase();
  return Boolean(replyTarget && selfId && replyTarget === selfId);
}

export function formatPadReplyText(text, message = {}, source = {}) {
  if (!source.strictPolicy) return String(text || "");
  const clean = stripAiReplyPrefix(text);
  return isSameAccountPrivateReply(message, source)
    ? `【AI】${clean}`
    : clean;
}

export class PadTransport {
  constructor(
    config,
    outboundMode,
    logger = console,
    fetchImpl = globalThis.fetch,
  ) {
    this.config = config;
    this.outboundMode = outboundMode;
    this.logger = logger;
    this.fetch = fetchImpl;
  }

  source(message = {}) {
    const source = this.config.sources?.length
      ? sourceForMessage({ pad: this.config }, message)
      : this.config;
    if (!source) {
      throw new Error(
        `Pad source is not configured: ${message.sourceId || "<empty>"}`,
      );
    }
    return source;
  }

  async request(path, body, message = {}, options = {}) {
    const source = this.source(message);
    if (this.outboundMode !== "live") {
      this.logger.info("pad outbound dry-run", {
        path,
        chatId: body.to || body.ToWxid,
        sourceId: source.id,
        bytes: body.content
          ? Buffer.byteLength(body.content)
          : body.Content
            ? Buffer.byteLength(body.Content)
            : undefined,
      });
      return { ok: true, dryRun: true };
    }

    const payload = { ...body };
    if (this.config.requireWriteConfirmation) {
      payload.confirm = true;
      payload.request_id = crypto.randomUUID();
    }
    const response = await this.fetch(
      `${source.apiUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: tokenHeaders(source.accessToken),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs || 30_000),
      },
    );
    const raw = await response.text();
    let result = {};
    try {
      result = JSON.parse(raw);
    } catch {
      result = {};
    }
    if (!padSucceeded(response, result)) {
      const detail = padFailureDetail(result);
      throw new Error(
        `Pad send failed for ${path} (${response.status})${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    return { ok: true, result };
  }

  async downloadInboundAttachment(message, attachment, dataDir) {
    const source = this.source(message);
    const context = attachment?.downloadContext;
    const endpoint = String(context?.endpoint || "");
    if (
      attachment?.kind !== "image" ||
      !endpoint.startsWith("/api/v1/media/download-img-binary")
    ) {
      throw new Error("attachment does not expose the complete image endpoint");
    }
    const response = await this.fetch(padEndpointURL(source, endpoint), {
      method: "POST",
      headers: tokenHeaders(source.accessToken),
      body: JSON.stringify({ image: { download_context: context } }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 300);
      throw new Error(
        `Pad image download failed (${response.status})${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_INBOUND_IMAGE_BYTES) {
      throw new Error("Pad image download exceeds 32 MiB");
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_INBOUND_IMAGE_BYTES) {
      throw new Error("Pad image download returned an invalid size");
    }
    const type = inboundImageType(data);
    const directory = path.join(
      path.resolve(dataDir),
      "inbound-media",
      safeFileSegment(source.id, "default"),
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const base = safeFileSegment(message.messageId, crypto.randomUUID());
    const filePath = path.join(directory, `${base}${type.extension}`);
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    return {
      localPath: filePath,
      filename: path.basename(filePath),
      mime: type.mime,
      size: data.length,
    };
  }

  send(message, text) {
    const source = this.source(message);
    const content = formatPadReplyText(text, message, source);
    return this.request("/v1/messages/send-text", {
      to: message.replyTarget || message.chatId,
      content,
      type: 1,
      at: "",
    }, message);
  }

  sendImage(chatId, base64, message = {}) {
    return this.request("/v1/messages/send-image", {
      to: chatId,
      data_base64: base64,
    }, message);
  }

  async sendArtifact(message, artifact = {}) {
    const filePath = path.resolve(String(artifact.path || ""));
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
      const error = new Error(
        "WeChat attachment must be a nonempty regular file of at most 64 MiB",
      );
      if (stat.isFile() && stat.size > MAX_FILE_BYTES) {
        error.code = "WEBOT_ATTACHMENT_TOO_LARGE";
        error.filePath = filePath;
        error.fileSize = stat.size;
      }
      throw error;
    }
    const data = fs.readFileSync(filePath);
    if (data.length !== stat.size) {
      throw new Error("WeChat attachment changed size while reading");
    }
    const filename = path.basename(String(artifact.filename || filePath));
    if (
      !filename ||
      Buffer.byteLength(filename) > 255 ||
      /[\x00-\x1f\x7f]/.test(filename)
    ) {
      throw new Error("invalid WeChat attachment name");
    }
    const extension = path.extname(filename).toLowerCase();
    const kind = String(artifact.kind || "").toLowerCase();
    const isImage =
      kind === "image" ||
      String(artifact.mime || "").toLowerCase().startsWith("image/") ||
      IMAGE_EXTENSIONS.has(extension);
    const audioFormat = AUDIO_FORMATS.get(extension);
    const isAudio =
      audioFormat != null &&
      (kind === "audio" || kind === "voice");
    const to = message.replyTarget || message.chatId;
    if (isImage) {
      return this.request("/v1/messages/send-image", {
        to,
        data_base64: data.toString("base64"),
      }, message);
    }
    if (isAudio) {
      if (stat.size > MAX_VOICE_BYTES) {
        throw new Error("WeChat voice attachment must be at most 5 MiB");
      }
      const durationMs = await probeAudioDurationMs(filePath, artifact);
      return this.request("/v1/messages/send-voice", {
        to,
        data_base64: data.toString("base64"),
        duration_ms: durationMs,
        format: audioFormat,
      }, message, { timeoutMs: 180_000 });
    }
    if (!this.config.requireWriteConfirmation) {
      throw new Error(
        "WeChat file cards require the confirmed-write Pad API",
      );
    }
    try {
      return await this.request("/v1/messages/send-file", {
        ToWxid: to,
        FileName: filename,
        Base64: data.toString("base64"),
      }, message, { timeoutMs: 180_000 });
    } catch (error) {
      if (/\(404\)/.test(String(error.message || error))) {
        throw new Error(
          "Pad gateway does not expose WeChat file-card delivery",
        );
      }
      throw error;
    }
  }
}

export class PadWebSocketClient {
  constructor(config, sourceValue, onMessage, logger = console) {
    this.config = config;
    this.source =
      typeof sourceValue === "string"
        ? { id: "default", displayName: "default", selfId: sourceValue, ...config }
        : sourceValue;
    this.onMessage = onMessage;
    this.logger = logger;
    this.socket = null;
    this.stopped = true;
    this.attempt = 0;
    this.timer = null;
    this.connectTimer = null;
    this.connectTimeoutMs = Math.max(
      1_000,
      Number(
        this.config.websocketConnectTimeoutMs ||
          DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
      ),
    );
    this.state = {
      connected: false,
      connectionState: "idle",
      lastConnectedAt: "",
      lastDisconnectedAt: "",
      lastMessageAt: "",
      lastError: "",
      reconnects: 0,
    };
  }

  start() {
    if (!this.config.wsUrl) return;
    if (typeof WebSocket !== "function") {
      throw new Error("Pad WebSocket requires Node.js 22 or newer");
    }
    this.stopped = false;
    this.connect();
  }

  clearConnectTimer() {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  disconnect(socket, error = "") {
    if (this.socket !== socket) return;
    this.clearConnectTimer();
    this.socket = null;
    this.state.connected = false;
    this.state.connectionState = this.stopped ? "stopped" : "disconnected";
    this.state.lastDisconnectedAt = new Date().toISOString();
    if (error) this.state.lastError = error;
    if (!this.stopped) this.reconnect();
  }

  connect() {
    if (this.stopped || this.socket || this.timer) return;
    let socket;
    try {
      const url = new URL(this.config.wsUrl);
      if (this.config.accessToken && !url.searchParams.has("access_token")) {
        url.searchParams.set("access_token", this.config.accessToken);
      }
      socket = new WebSocket(url);
    } catch (error) {
      this.state.lastError = String(error.message || error);
      this.state.connectionState = "disconnected";
      this.reconnect();
      return;
    }
    this.socket = socket;
    this.state.connectionState = "connecting";
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket || this.state.connected) return;
      this.disconnect(
        socket,
        `websocket connection timed out after ${this.connectTimeoutMs}ms`,
      );
    }, this.connectTimeoutMs);
    this.connectTimer.unref?.();

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.state.connected = true;
      this.state.connectionState = "connected";
      this.state.lastConnectedAt = new Date().toISOString();
      this.state.lastError = "";
      this.logger.info("pad websocket connected", {
        sourceId: this.source.id,
        selfId: this.source.selfId,
      });
    });
    socket.addEventListener("message", async (event) => {
      if (this.socket !== socket) return;
      try {
        this.state.lastMessageAt = new Date().toISOString();
        const raw =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof Blob
              ? await event.data.text()
              : Buffer.from(event.data).toString("utf8");
        const envelope = JSON.parse(raw);
        for (const message of normalizePadEnvelope(envelope, this.source)) {
          await this.onMessage(message);
        }
      } catch (error) {
        this.state.lastError = error.message;
        this.logger.error("invalid pad websocket event", {
          sourceId: this.source.id,
          error: error.message,
        });
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.disconnect(socket, "websocket error");
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      const reason = String(event?.reason || "").trim();
      this.disconnect(socket, reason || this.state.lastError);
    });
  }

  reconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++);
    this.logger.warn("pad websocket disconnected", {
      sourceId: this.source.id,
      retryMs: delay,
    });
    this.state.connectionState = "reconnecting";
    this.timer = setTimeout(() => {
      this.timer = null;
      this.state.reconnects += 1;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.clearConnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.state.connected = false;
    this.state.connectionState = "stopped";
    if (socket?.readyState === WEBSOCKET_OPEN) {
      try {
        socket.close();
      } catch {
        // The service is stopping; the socket is already detached.
      }
    }
  }

  status() {
    return {
      sourceId: this.source.id,
      ...this.state,
    };
  }
}
