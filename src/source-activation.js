import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BROKER_URL = "http://127.0.0.1:19231";

export function activationSuppressed(text) {
  return /(?:不要|不用|暂不|先不|别)(?:自动|受控)?重启|do not restart|no restart/i.test(
    String(text || ""),
  );
}

export async function sourceCandidate({
  env = process.env,
  repoDir = env.WEBOT_REPO_DIR || process.cwd(),
  run = execFileAsync,
  readFile = fs.readFile,
  includeCurrent = false,
} = {}) {
  if (String(env.WEBOT_RUNTIME_MODE || "") !== "source") return null;
  const currentRevision = String(env.WEBOT_SOURCE_REVISION || "").trim();
  const { stdout } = await run(
    "/usr/bin/git",
    ["-C", path.resolve(repoDir), "rev-parse", "HEAD"],
    { encoding: "utf8" },
  );
  const revision = String(stdout || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(revision) || (!includeCurrent && revision === currentRevision)) {
    return null;
  }
  const packageJson = JSON.parse(
    await readFile(path.join(path.resolve(repoDir), "package.json"), "utf8"),
  );
  const version = String(packageJson.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Webot package version is not semantic");
  }
  return { version, revision };
}

export function createSourceActivator({
  env = process.env,
  fetchImpl = fetch,
  candidate = sourceCandidate,
  ready = () => true,
  idle = () => true,
  reserveIdle = () => ({ release() {} }),
  onDeferredResult = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  now = Date.now,
  readinessTimeoutMs = 300_000,
} = {}) {
  const brokerUrl = String(
    env.WEBOT_ACTIVATION_BROKER_URL
      || env.SEATALK_MONITOR_URL
      || DEFAULT_BROKER_URL,
  ).replace(/\/+$/, "");
  const pending = new Map();
  async function submit(next, { caseId, sourceId }) {
    let response;
    let body;
    try {
      response = await fetchImpl(
        `${brokerUrl}/api/webot_source_activation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            case_id: String(caseId || ""),
            requester_access: "owner",
            service: "com.huwatermelon.webot",
            action: "restart",
            expected_version: next.version,
            expected_source_revision: next.revision,
            expected_source_id: String(sourceId || ""),
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      body = await response.json();
    } catch (error) {
      error.activationUncertain = true;
      throw error;
    }
    if (!response.ok || body.ok !== true) {
      throw new Error(
        `Webot activation broker rejected the candidate: ${
          body.error || `HTTP ${response.status}`
        }`,
      );
    }
    return {
      requested: true,
      version: next.version,
      revision: next.revision,
      activationId: String(body.activation_id || ""),
    };
  }
  async function submitWhenIdle(next, context) {
    if (!ready() || !idle()) return null;
    const reservation = reserveIdle();
    if (!reservation) return null;
    try {
      return await submit(next, context);
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  function defer(context, includeCurrent = false, pinnedCandidate = null) {
    if (!pending.has(context.caseId)) {
      const ticket = {};
      let deadline = now() + readinessTimeoutMs;
      pending.set(context.caseId, ticket);
      const poll = async () => {
        if (pending.get(context.caseId) !== ticket) return;
        try {
          // Busy workers are not a failed health check and never time out a reload.
          if (!idle()) {
            deadline = now() + readinessTimeoutMs;
          } else if (!ready()) {
            if (now() >= deadline) {
              throw new Error("Webot activation readiness timed out");
            }
          } else {
            const next = includeCurrent
              ? pinnedCandidate
              : await candidate({ env });
            const result = next
              ? await submitWhenIdle(next, context)
              : { requested: false, reason: "source-current" };
            if (result) {
              pending.delete(context.caseId);
              onDeferredResult(context, result);
              return;
            }
          }
          schedule(poll, 1000).unref?.();
        } catch (error) {
          pending.delete(context.caseId);
          onDeferredResult(context, null, error);
        }
      };
      schedule(poll, 1000).unref?.();
    }
    return {
      requested: false,
      pending: true,
      reason: idle() ? "waiting-for-ingress" : "waiting-for-idle",
      ...(pinnedCandidate ? {
        version: pinnedCandidate.version,
        revision: pinnedCandidate.revision,
      } : {}),
    };
  }

  return {
    async restartFromConsole({ sourceId }) {
      if (!ready()) {
        throw new Error("连接或配置尚未就绪，暂不能提交受控重载；请查看账号连接状态。");
      }
      const next = await candidate({ env, includeCurrent: true });
      if (!next) throw new Error("当前运行模式不支持源码重载");
      const context = {
        caseId: `console-restart-${now()}`,
        sourceId,
        console: true,
      };
      const result = await submitWhenIdle(next, context);
      return result || defer(context, true, next);
    },
    async activate(context) {
      const { caseId, message } = context;
      if (activationSuppressed(message?.text)) {
        pending.delete(caseId);
        return { requested: false, reason: "explicitly-suppressed" };
      }
      const next = await candidate({ env });
      if (!next) return { requested: false, reason: "source-current" };
      // afterOwnerRun still owns a worker slot; let it finish without closing
      // scheduling, then atomically reserve an empty queue before submission.
      const result = await submitWhenIdle(next, context);
      if (!result) return defer(context);
      pending.delete(caseId);
      return result;
    },
  };
}
