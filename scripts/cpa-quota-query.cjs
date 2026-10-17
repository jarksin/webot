"use strict";

const fs = require("node:fs");
const path = require("node:path");

function runtimeDirectory() {
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!/(?:^|\0|\/)cpa-manager-plus(?:\0|$)/.test(command)) continue;
      const directory = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (fs.existsSync(path.join(directory, "config.json"))) return directory;
    } catch {}
  }
  throw new Error("quota manager unavailable");
}

function number(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quotaSnapshot(auth) {
  const candidates = [
    auth.quota,
    ...Object.values(auth.model_quotas || {}),
  ].filter((quota) => quota && typeof quota.signals === "object" && quota.signals);
  candidates.sort((a, b) => (
    (Date.parse(b.observed_at) || 0) - (Date.parse(a.observed_at) || 0)
  ));
  const quota = candidates.find((item) => (
    number(item.signals["X-Codex-Primary-Used-Percent"]) !== null
  )) || candidates[0];
  if (!quota) return null;
  const signals = quota.signals;
  return {
    plan: String(signals["X-Codex-Plan-Type"] || ""),
    used_percent: number(signals["X-Codex-Primary-Used-Percent"]),
    window_minutes: number(signals["X-Codex-Primary-Window-Minutes"]),
    reset_at: number(signals["X-Codex-Primary-Reset-At"]),
    observed_at: String(quota.observed_at || ""),
  };
}

async function query() {
  const directory = runtimeDirectory();
  const config = JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"));
  if (!config.managementKeyFile) throw new Error("quota management unavailable");
  const key = fs.readFileSync(path.resolve(directory, config.managementKeyFile), "utf8").trim();
  if (!key) throw new Error("quota management unavailable");
  const url = new URL("/v0/management/auth-files", config.cpaUpstreamUrl || "http://127.0.0.1:8317");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("quota endpoint must be loopback");
  }
  const endpoints = [url.toString()];
  if (url.hostname !== "[::1]") {
    url.hostname = "[::1]";
    endpoints.push(url.toString());
  }
  let rows;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("quota response rejected");
      const body = await response.json();
      rows = Array.isArray(body) ? body : body?.files || body?.items || body?.data;
      if (!Array.isArray(rows)) throw new Error("invalid quota response");
      break;
    } catch {
      rows = null;
    }
  }
  if (!rows) throw new Error("quota query unavailable");
  const enabled = rows.filter((auth) => auth && auth.disabled !== true).map((auth) => ({
    name: String(auth.email || auth.label || auth.account || auth.name || ""),
    status: String(auth.status || ""),
    unavailable: Boolean(auth.unavailable),
    cooldown_count: Array.isArray(auth.cooldowns) ? auth.cooldowns.length : 0,
    quota: quotaSnapshot(auth),
  }));
  console.log(JSON.stringify({ ok: true, enabled, fetched_at: new Date().toISOString() }));
}

query().catch(() => {
  // Never forward upstream response bodies or management credentials.
  console.error("quota metadata query failed");
  process.exitCode = 1;
});
