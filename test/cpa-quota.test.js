import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import {
  formatCpaQuota, normalizeQuotaResult, queryCpaQuota,
} from "../src/cpa-quota.js";
import { cpaSshHost } from "../src/model-catalog-probe.js";

const sample = {
  ok: true,
  enabled: [{
    name: "example@example.com",
    status: "active",
    quota: {
      plan: "pro", used_percent: "65", remaining_percent: 999,
      window_minutes: 10080, reset_at: 1792202400,
      observed_at: "2026-10-17T00:00:00Z",
    },
    token: "not-a-real-credential",
  }, {
    name: "cooldown", status: "active", cooldown_count: 1,
    quota: { used_percent: 100, window_minutes: 300 },
  }, { name: "unknown", quota: null }],
  fetched_at: "2026-10-17T00:01:00Z",
  secret: "not-a-real-secret",
};

test("quota output whitelists fields, calculates remaining and labels unknown and cooldown", () => {
  const normalized = normalizeQuotaResult(sample);
  assert.equal(normalized.enabled[0].quota.remaining, 35);
  assert.doesNotMatch(JSON.stringify(normalized), /not-a-real|secret|token/);
  const text = formatCpaQuota(sample);
  assert.match(text, /剩余 35%（已用 65%） · 周额度/);
  assert.match(text, /5 小时额度 · 冷却中/);
  assert.match(text, /余量未知/);
  assert.match(text, /10\/17 08:00 观测/);
  assert.match(text, /北京时间/);
  assert.doesNotMatch(text, /NaN|undefined|null|20x/);
  assert.match(formatCpaQuota({ ok: true, enabled: [] }), /没有启用/);
  assert.throws(() => normalizeQuotaResult({ ok: false, enabled: [] }));
  assert.throws(() => normalizeQuotaResult({ ok: true }));
});

test("missing and invalid percentages never appear as zero use or full quota", () => {
  for (const used of [null, undefined, "", " ", "oops", -1, 101, Infinity]) {
    const value = { ok: true, enabled: [{ name: "unknown", quota: { used_percent: used } }] };
    assert.match(formatCpaQuota(value), /余量未知/);
    assert.doesNotMatch(formatCpaQuota(value), /剩余 100%|已用 0%|1970/);
  }
});

function fakeSpawn(callback) {
  const calls = [];
  function spawn(binary, args, options) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = (signal) => child.killed.push(signal);
    calls.push({ binary, args, options, child });
    callback(child);
    return child;
  }
  return { calls, spawn };
}

test("quota SSH uses the model-probe host and sends only a read-only program on stdin", async () => {
  const f = fakeSpawn((child) => {
    child.stdin.on("data", (data) => {
      assert.match(data.toString(), /\/v0\/management\/auth-files/);
      assert.doesNotMatch(data.toString(), /not-a-real-credential/);
    });
    setImmediate(() => {
      child.stdout.end(JSON.stringify(sample));
      child.emit("close", 0);
    });
  });
  const env = { WEBOT_CPA_SSH_HOST: "test-quota-host" };
  assert.equal(cpaSshHost(env), "test-quota-host");
  const result = await queryCpaQuota(env, { spawn: f.spawn });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls[0].args, [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-T", "test-quota-host", "sudo", "-n", "node",
  ]);
  assert.equal(f.calls.length, 1);
  assert.equal(cpaSshHost({ SEATALK_CPA_COMPANY_GATEWAY_SSH_HOST: "legacy-test" }), "legacy-test");
  await assert.rejects(queryCpaQuota({ WEBOT_CPA_SSH_HOST: "-oCommand" }), /配置无效/);
});

test("quota transport failures never echo stderr, credentials or malformed payloads", async () => {
  for (const [code, stdout, stderr] of [
    [1, "", "Authorization: Bearer private-example"],
    [0, '{"secret":"private-example"}', ""],
    [0, "private-example", ""],
    [0, '{"ok":false,"enabled":[],"error":"private-example"}', ""],
  ]) {
    const f = fakeSpawn((child) => setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code);
    }));
    await assert.rejects(queryCpaQuota({}, { spawn: f.spawn }), (error) => {
      assert.doesNotMatch(error.message, /private-example|Bearer/);
      return true;
    });
  }
});

test("quota timeouts and response budgets terminate only the SSH query", async () => {
  const timed = fakeSpawn(() => {});
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(queryCpaQuota({}, { spawn: timed.spawn, timeoutMs: 10 }), /超时/);
    assert.deepEqual(timed.calls[0].child.killed, ["SIGTERM"]);
  } finally {
    clearTimeout(keepAlive);
  }
  const huge = fakeSpawn((child) => setImmediate(() => {
    child.stdout.write("x".repeat(1024 * 1024 + 1));
  }));
  await assert.rejects(queryCpaQuota({}, { spawn: huge.spawn }), /大小限制/);
  assert.deepEqual(huge.calls[0].child.killed, ["SIGTERM"]);
});

async function runRemote(rows, { rejected = false } = {}) {
  const script = fs.readFileSync(new URL("../scripts/cpa-quota-query.cjs", import.meta.url), "utf8");
  const done = Promise.withResolvers();
  const requests = [];
  const errors = [];
  const fakeFs = {
    readdirSync: () => ["123", "not-a-pid"],
    readlinkSync: () => "/test/runtime",
    existsSync: () => true,
    readFileSync(file) {
      if (file.endsWith("cmdline")) return "cpa-manager-plus\0";
      if (file.endsWith("config.json")) return JSON.stringify({
        managementKeyFile: "management-key",
        cpaUpstreamUrl: "http://127.0.0.1:8317",
      });
      return "synthetic-manager-secret";
    },
  };
  vm.runInNewContext(script, {
    require: (name) => name === "node:fs" ? fakeFs : path,
    URL, AbortSignal, process: {
      set exitCode(value) { done.resolve({ exitCode: value, requests, errors }); },
    },
    console: {
      log(line) { done.resolve({ body: JSON.parse(line), requests, errors }); },
      error(line) { errors.push(line); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (rejected) throw new Error("synthetic-manager-secret");
      return { ok: true, json: async () => ({ files: rows }) };
    },
  });
  return done.promise;
}

test("remote probe excludes disabled accounts and secrets, preserving the latest valid observation", async () => {
  const result = await runRemote([
    { name: "disabled", disabled: true, token: "private" },
    {
      email: "test@example.com", status: "active", token: "private",
      quota: { observed_at: "2026-10-17T00:00:00Z", signals: {} },
      model_quotas: {
        older: {
          observed_at: "2026-10-16T00:00:00Z",
          signals: { "X-Codex-Primary-Used-Percent": 75 },
        },
      },
    },
  ]);
  assert.equal(result.body.enabled.length, 1);
  assert.equal(result.body.enabled[0].quota.used_percent, 75);
  assert.equal(result.body.enabled[0].quota.reset_at, null);
  assert.doesNotMatch(JSON.stringify(result.body), /private|synthetic-manager-secret/);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].options.redirect, "error");
  assert.equal(result.requests[0].options.method, undefined);
  const failed = await runRemote([], { rejected: true });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.requests.length, 2);
  assert.doesNotMatch(failed.errors.join(" "), /synthetic-manager-secret/);
});

test("quota code can be bundled for the packaged Node runtime", async () => {
  const result = await build({
    entryPoints: ["src/cpa-quota.js"], bundle: true, write: false,
    platform: "node", format: "cjs", logLevel: "silent",
  });
  assert.equal(result.warnings.length, 0);
  const release = fs.readFileSync("scripts/build-release.mjs", "utf8");
  assert.match(release, /path\.join\(root, "scripts", "cpa-quota-query\.cjs"\)/);
  assert.match(release, /path\.join\("scripts", "cpa-quota-query\.cjs"\)/);
});
