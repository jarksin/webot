import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  estimateCodexCostUsd,
  parseCodexSessionUsage,
} from "../src/codex-usage.js";

test("reads cumulative and current-run usage from Codex session JSONL", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "webot-usage-"));
  const sessionId = "usage-session";
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "09", "15");
  const file = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`);
  await fs.mkdir(sessionDirectory, { recursive: true });
  const firstAt = Date.parse("2026-09-15T10:00:00.000Z");
  const secondAt = Date.parse("2026-09-15T10:01:00.000Z");
  const event = (timestamp, total, last) => JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
    },
  });
  await fs.writeFile(file, [
    event(firstAt, {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 100_000,
      reasoning_output_tokens: 20_000,
    }, {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 100_000,
      reasoning_output_tokens: 20_000,
    }),
    event(secondAt, {
      input_tokens: 1_100_000,
      cached_input_tokens: 850_000,
      output_tokens: 110_000,
      reasoning_output_tokens: 21_000,
    }, {
      input_tokens: 100_000,
      cached_input_tokens: 50_000,
      output_tokens: 10_000,
      reasoning_output_tokens: 1_000,
    }),
  ].join("\n"));

  const usage = parseCodexSessionUsage({
    sessionId,
    codexHome,
    runStartedAt: secondAt - 1_000,
    runEndedAt: secondAt + 1_000,
    model: "company-gpt-5.6-sol",
  });
  assert.deepEqual(usage.runUsage, {
    inputTokens: 100_000,
    cachedInputTokens: 50_000,
    cacheWriteInputTokens: 0,
    outputTokens: 10_000,
    reasoningOutputTokens: 1_000,
  });
  assert.equal(usage.runRequestCount, 1);
  assert.equal(usage.cumulativeRequestCount, 2);
  assert.equal(usage.cumulativeUsage.inputTokens, 1_100_000);
  assert.equal(usage.runEstimatedCostUsd, 0.575);
  assert.equal(usage.cumulativeEstimatedCostUsd, 7.875);
});

test("returns an unknown cost for unpriced models", () => {
  assert.equal(
    estimateCodexCostUsd(
      { inputTokens: 100, outputTokens: 20 },
      "private-model",
    ),
    null,
  );
});
