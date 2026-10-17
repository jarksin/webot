import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cpaSshHost } from "./model-catalog-probe.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function number(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeQuotaResult(value) {
  if (value?.ok !== true || !Array.isArray(value.enabled)) {
    throw new Error("额度响应格式无效");
  }
  return {
    enabled: value.enabled.map((auth) => {
      const quota = auth?.quota;
      const used = number(quota?.used_percent);
      const validUsed = used !== null && used >= 0 && used <= 100 ? used : null;
      return {
        name: String(auth?.name || "").replace(/[\r\n\t]/g, " ").slice(0, 120),
        status: String(auth?.status || ""),
        unavailable: Boolean(auth?.unavailable),
        cooldown: Number(auth?.cooldown_count) > 0,
        quota: quota && typeof quota === "object" ? {
          plan: String(quota.plan || "").replace(/[\r\n\t]/g, " ").slice(0, 40),
          used: validUsed,
          remaining: validUsed === null ? null : 100 - validUsed,
          window: number(quota.window_minutes),
          reset: number(quota.reset_at),
          observed: String(quota.observed_at || ""),
        } : null,
      };
    }),
    fetchedAt: String(value.fetched_at || ""),
  };
}

export function queryCpaQuota(env = process.env, options = {}) {
  const host = cpaSshHost(env, options);
  if (!host || host.startsWith("-") || /[\s\0]/.test(host)) {
    return Promise.reject(new Error("额度查询 SSH 配置无效"));
  }
  const timeoutMs = options.timeoutMs ?? 30000;
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-T", host,
      "sudo", "-n", "node",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let bytes = 0;
    let settled = false;
    let timer;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    timer = setTimeout(() => {
      finish(new Error("额度查询超时，请稍后重试"));
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(new Error("无法启动额度查询")));
    child.stdin.on("error", () => finish(new Error("额度查询连接中断")));
    for (const [stream, capture] of [[child.stdout, true], [child.stderr, false]]) {
      stream.on("data", (chunk) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) {
          finish(new Error("额度响应超过大小限制"));
          child.kill("SIGTERM");
        } else if (capture) stdout += chunk.toString();
      });
    }
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error("额度查询服务不可用"));
      try {
        const line = stdout.trim().split(/\r?\n/).at(-1);
        const raw = JSON.parse(line);
        normalizeQuotaResult(raw);
        finish(null, raw);
      } catch {
        finish(new Error("额度响应格式无效"));
      }
    });
    try {
      const script = path.join(
        env.WEBOT_REPO_DIR || process.cwd(), "scripts", "cpa-quota-query.cjs",
      );
      child.stdin.end(fs.readFileSync(script, "utf8"));
    } catch {
      finish(new Error("额度查询程序不可用"));
      child.kill("SIGTERM");
    }
  });
}

function time(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function windowLabel(minutes) {
  if (minutes === 300) return "5 小时额度";
  if (minutes >= 10020 && minutes <= 10140) return "周额度";
  if (!minutes || minutes <= 0) return "额度窗口未知";
  return minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`;
}

export function formatCpaQuota(value) {
  const result = normalizeQuotaResult(value);
  const enabled = result.enabled.sort((a, b) => (
    Number(a.unavailable || a.cooldown || a.status !== "active")
      - Number(b.unavailable || b.cooldown || b.status !== "active")
    || (b.quota?.remaining ?? -1) - (a.quota?.remaining ?? -1)
  ));
  if (!enabled.length) return "CPA 当前没有启用的账号。";
  const lines = [`CPA 已启用 ${enabled.length} 个账号（额度为最近观测值）：`];
  for (const [index, auth] of enabled.entries()) {
    const quota = auth.quota;
    const parts = [`${index + 1}. ${auth.name || "未命名账号"}`];
    parts.push(quota?.plan || "套餐未知");
    parts.push(quota?.remaining != null
      ? `剩余 ${Math.round(quota.remaining)}%（已用 ${Math.round(quota.used)}%）`
      : "余量未知");
    if (quota) {
      parts.push(windowLabel(quota.window));
      const reset = time(quota.reset);
      const observed = time(quota.observed);
      if (reset) parts.push(`${reset} 重置`);
      if (observed) parts.push(`${observed} 观测`);
    }
    parts.push(auth.cooldown ? "冷却中"
      : auth.unavailable ? "不可用"
        : auth.status === "active" ? "可用" : "状态未确认");
    lines.push(parts.join(" · "));
  }
  const fetched = time(result.fetchedAt);
  if (fetched) lines.push(`查询时间：${fetched}（北京时间）`);
  return lines.join("\n");
}
