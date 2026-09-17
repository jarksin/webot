import { spawn } from "node:child_process";
import {
  codexRuntimeStatus,
  parseAssistantResult,
  resolveCodexBin,
} from "./codex-provider.js";
import { parseCodexSessionUsage } from "./codex-usage.js";

function clean(value) {
  return String(value || "").trim();
}

function appServerConfig(runtime) {
  const filters = {};
  for (const key of runtime.credentialKeys || []) filters[key] = "exclude";
  return {
    shell_environment_policy: {
      inherit: "all",
      ignore_default_excludes: false,
      filters,
    },
  };
}

function sandboxPolicy() {
  return { type: "dangerFullAccess" };
}

function finalAgentText(turn) {
  const messages = (turn?.items || [])
    .filter((item) => item?.type === "agentMessage")
    .map((item) => clean(item.text))
    .filter(Boolean);
  return messages.at(-1) || "";
}

class AppServerClient {
  constructor({ binary, cwd, env, onNotification, onClose }) {
    this.binary = binary;
    this.cwd = cwd;
    this.env = env;
    this.onNotification = onNotification;
    this.onClose = onClose;
    this.child = null;
    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = null;
  }

  async start() {
    this.child = spawn(this.binary, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolve) => {
      this.child.once("close", (status) => {
        const detail = clean(this.stderr).split(/\r?\n/).slice(-8).join("\n");
        const error = new Error(
          detail || `Codex app-server exited with status ${Number(status ?? 1)}`,
        );
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.onClose?.(error);
        resolve();
      });
    });
    this.child.once("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.onClose?.(error);
    });
    this.child.stdout.on("data", (chunk) => this.consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-256 * 1024);
    });
    await this.request("initialize", {
      clientInfo: {
        name: "webot",
        title: "Webot",
        version: "0.6",
      },
    });
    this.notify("initialized", {});
  }

  consume(chunk) {
    this.buffer += String(chunk || "");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(
            clean(message.error.message) || "Codex app-server request failed",
          );
          error.code = message.error.code;
          error.data = message.error.data;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (message.method) this.onNotification?.(message);
    }
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is not writable"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child?.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child?.kill("SIGKILL"), 5_000);
    force.unref?.();
    await this.closed;
    clearTimeout(force);
  }
}

export async function runCodexAppServer(config, request) {
  const runtime = codexRuntimeStatus(config);
  const runStartedAt = Date.now();
  const timeoutMs = Math.max(0, Number(config.timeoutMs ?? 0));
  let timeout = null;
  let completed = null;
  let completeTurn;
  let failTurn;
  let aborted = false;
  let activeTurnId = "";
  let threadId = "";
  let itemDelivery = Promise.resolve();
  const deliveredItems = new Set();
  const completion = new Promise((resolve, reject) => {
    completeTurn = resolve;
    failTurn = reject;
  });
  const deliverItem = (text) => {
    const value = clean(text);
    if (!value || deliveredItems.has(value)) return;
    deliveredItems.add(value);
    if (typeof request.onItem === "function") {
      itemDelivery = itemDelivery.then(() =>
        request.onItem({ type: "agent_message", text: value }),
      );
    }
  };
  const client = new AppServerClient({
    binary: resolveCodexBin(config),
    cwd: runtime.effective.workingDirectory,
    env: {
      ...process.env,
      CODEX_HOME: runtime.home,
    },
    onNotification(message) {
      const params = message.params || {};
      if (
        message.method === "item/completed" &&
        params.turnId === activeTurnId &&
        params.item?.type === "agentMessage"
      ) {
        if (params.item.phase !== "final_answer") deliverItem(params.item.text);
      }
      if (
        message.method === "turn/completed" &&
        params.threadId === threadId &&
        params.turn?.id === activeTurnId
      ) {
        completed = params.turn;
        completeTurn(params.turn);
      }
      if (
        message.method === "error" &&
        params.willRetry !== true &&
        (!params.turnId || params.turnId === activeTurnId)
      ) {
        failTurn(
          new Error(
            clean(params.error?.message) ||
              clean(params.message) ||
              "Codex turn failed",
          ),
        );
      }
    },
    onClose(error) {
      failTurn(error);
    },
  });
  const abort = () => {
    aborted = true;
    if (threadId && activeTurnId) {
      client.request("turn/interrupt", {
        threadId,
        turnId: activeTurnId,
      }).catch(() => {});
    }
    failTurn(new Error("Codex worker stopped"));
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) abort();
    await client.start();
    if (aborted) throw new Error("Codex worker stopped");
    const common = {
      cwd: runtime.effective.workingDirectory,
      model: runtime.effective.model || null,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: clean(request.instancePolicy),
      serviceTier: runtime.effective.serviceTier || null,
      config: appServerConfig(runtime),
    };
    const thread = request.sessionId
      ? await client.request("thread/resume", {
          ...common,
          threadId: request.sessionId,
          excludeTurns: true,
        })
      : await client.request("thread/start", common);
    if (aborted) throw new Error("Codex worker stopped");
    threadId = clean(thread?.thread?.id) || clean(request.sessionId);
    if (!threadId) throw new Error("Codex app-server returned no thread id");
    const started = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt }],
      model: runtime.effective.model || null,
      effort: runtime.effective.reasoningEffort || null,
      approvalPolicy: "never",
      sandboxPolicy: sandboxPolicy(),
      serviceTierForTurn: runtime.effective.serviceTier || null,
    });
    activeTurnId = clean(started?.turn?.id);
    if (!activeTurnId) throw new Error("Codex app-server returned no turn id");
    request.onActiveTurn?.({
      threadId,
      turnId: activeTurnId,
      async steer(text, clientUserMessageId = "") {
        const result = await client.request("turn/steer", {
          threadId,
          expectedTurnId: activeTurnId,
          input: [{ type: "text", text: clean(text) }],
          clientUserMessageId: clean(clientUserMessageId) || null,
        });
        return {
          accepted: clean(result?.turnId) === activeTurnId,
          threadId,
          turnId: activeTurnId,
        };
      },
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        failTurn(new Error(`Codex timed out after ${timeoutMs}ms`));
        client.request("turn/interrupt", {
          threadId,
          turnId: activeTurnId,
        }).catch(() => {});
      }, timeoutMs);
    }
    const turn = await completion;
    await itemDelivery;
    if (aborted) throw new Error("Codex worker stopped");
    if (turn?.status !== "completed") {
      throw new Error(
        clean(turn?.error?.message) || `Codex turn ended as ${turn?.status}`,
      );
    }
    const output = finalAgentText(turn);
    if (!output) throw new Error("Codex returned no final message");
    const assistant = parseAssistantResult(output);
    const sessionUsage = parseCodexSessionUsage({
      sessionId: threadId,
      codexHome: runtime.home,
      runStartedAt,
      runEndedAt: Date.now(),
      model: runtime.effective.model,
    });
    return {
      ...assistant,
      sessionId: threadId,
      usage: sessionUsage?.runUsage || {},
      cumulativeUsage: sessionUsage?.cumulativeUsage,
      requestCount: sessionUsage?.runRequestCount,
      cumulativeRequestCount: sessionUsage?.cumulativeRequestCount,
      estimatedCostUsd: sessionUsage?.runEstimatedCostUsd,
      cumulativeEstimatedCostUsd:
        sessionUsage?.cumulativeEstimatedCostUsd,
      model: runtime.effective.model,
      effort: runtime.effective.reasoningEffort,
    };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
    if (!completed && activeTurnId && !aborted) {
      await client.request("turn/interrupt", {
        threadId,
        turnId: activeTurnId,
      }).catch(() => {});
    }
    await client.close();
  }
}
