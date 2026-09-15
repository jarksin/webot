import fs from "node:fs";
import { locateCodexSessionFile } from "./codex-session-progress.js";

const MTOK = 1_000_000;
const LONG_CONTEXT_THRESHOLD = 272_000;

const MODEL_PRICING = [
  {
    pattern: /^gpt-5\.6(?:-sol)?$/,
    input: 5,
    cachedInput: 0.5,
    output: 30,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  {
    pattern: /^gpt-5\.6-terra$/,
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  {
    pattern: /^gpt-5\.6-luna$/,
    input: 1,
    cachedInput: 0.1,
    output: 6,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  {
    pattern: /^gpt-5\.5$/,
    input: 5,
    cachedInput: 0.5,
    output: 30,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
  },
  {
    pattern: /^gpt-5\.4-mini$/,
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
  },
  {
    pattern: /^gpt-5\.4$/,
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
  },
];

function tokenCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function normalizeCodexUsage(value = {}) {
  return {
    inputTokens: tokenCount(value.inputTokens ?? value.input_tokens),
    cachedInputTokens: tokenCount(
      value.cachedInputTokens ?? value.cached_input_tokens,
    ),
    cacheWriteInputTokens: tokenCount(
      value.cacheWriteInputTokens ?? value.cache_write_input_tokens,
    ),
    outputTokens: tokenCount(value.outputTokens ?? value.output_tokens),
    reasoningOutputTokens: tokenCount(
      value.reasoningOutputTokens ?? value.reasoning_output_tokens,
    ),
  };
}

function normalizedModel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:company[-_/])+/u, "");
}

function priceOverride(env = process.env) {
  const values = {
    input: Number(env.WEBOT_CODEX_PRICE_INPUT_PER_MTOK),
    cachedInput: Number(env.WEBOT_CODEX_PRICE_CACHED_INPUT_PER_MTOK),
    output: Number(env.WEBOT_CODEX_PRICE_OUTPUT_PER_MTOK),
  };
  return Object.values(values).every(
    (value) => Number.isFinite(value) && value >= 0,
  )
    ? values
    : null;
}

export function estimateCodexCostUsd(
  value = {},
  model = "",
  env = process.env,
) {
  const usage = normalizeCodexUsage(value);
  const total = usage.inputTokens + usage.outputTokens;
  if (!total) return 0;
  const base = priceOverride(env)
    || MODEL_PRICING.find((entry) => entry.pattern.test(normalizedModel(model)));
  if (!base) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const longContext = usage.inputTokens > LONG_CONTEXT_THRESHOLD;
  const inputMultiplier = longContext ? (base.longInputMultiplier || 1) : 1;
  const outputMultiplier = longContext ? (base.longOutputMultiplier || 1) : 1;
  return (
    (uncached * base.input * inputMultiplier)
    + (cached * base.cachedInput * inputMultiplier)
    + (usage.outputTokens * base.output * outputMultiplier)
  ) / MTOK;
}

function addUsage(target, value) {
  const usage = normalizeCodexUsage(value);
  for (const key of Object.keys(target)) target[key] += usage[key];
}

export function parseCodexSessionUsage({
  sessionId,
  codexHome = "",
  runStartedAt = 0,
  runEndedAt = 0,
  model = "",
  env = process.env,
} = {}) {
  const file = locateCodexSessionFile(sessionId, codexHome);
  if (!file) return null;
  let content = "";
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const runUsage = normalizeCodexUsage();
  const summedUsage = normalizeCodexUsage();
  let cumulativeUsage = null;
  let runRequestCount = 0;
  let cumulativeRequestCount = 0;
  let runEstimatedCostUsd = 0;
  let cumulativeEstimatedCostUsd = 0;
  let runCostKnown = true;
  let cumulativeCostKnown = true;
  const hasRunWindow = Number(runStartedAt || 0) > 0
    || Number(runEndedAt || 0) > 0;
  const start = Number(runStartedAt || 0) - 3_000;
  const end = Number(runEndedAt || Date.now()) + 3_000;

  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      event?.type !== "event_msg"
      || event?.payload?.type !== "token_count"
    ) {
      continue;
    }
    const info = event.payload.info || {};
    const lastUsage = normalizeCodexUsage(info.last_token_usage);
    const requestTokens = lastUsage.inputTokens + lastUsage.outputTokens;
    if (info.total_token_usage) {
      cumulativeUsage = normalizeCodexUsage(info.total_token_usage);
    }
    if (!requestTokens) continue;

    cumulativeRequestCount += 1;
    addUsage(summedUsage, lastUsage);
    const requestCost = estimateCodexCostUsd(lastUsage, model, env);
    if (requestCost == null) cumulativeCostKnown = false;
    else cumulativeEstimatedCostUsd += requestCost;

    const timestamp = Date.parse(String(event.timestamp || ""));
    const inRun = !hasRunWindow
      || (Number.isFinite(timestamp) && timestamp >= start && timestamp <= end);
    if (!inRun) continue;
    runRequestCount += 1;
    addUsage(runUsage, lastUsage);
    if (requestCost == null) runCostKnown = false;
    else runEstimatedCostUsd += requestCost;
  }

  return {
    file,
    runUsage,
    cumulativeUsage: cumulativeUsage || summedUsage,
    runRequestCount,
    cumulativeRequestCount,
    runEstimatedCostUsd: runCostKnown ? runEstimatedCostUsd : null,
    cumulativeEstimatedCostUsd:
      cumulativeCostKnown ? cumulativeEstimatedCostUsd : null,
  };
}
