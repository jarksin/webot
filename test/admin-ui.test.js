import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(
  new URL("../ui/admin.html", import.meta.url),
  "utf8",
);
const javascript = fs.readFileSync(
  new URL("../ui/admin.js", import.meta.url),
  "utf8",
);
const css = fs.readFileSync(
  new URL("../ui/admin.css", import.meta.url),
  "utf8",
);

test("admin navigation exposes cases, ID directory, knowledge, and settings", () => {
  assert.match(html, /data-view="cases"/);
  assert.match(html, /data-view="directory"/);
  assert.match(html, /data-view="knowledge"/);
  assert.match(html, /data-view="settings"/);
  assert.doesNotMatch(html, /data-view="overview"/);
  assert.doesNotMatch(html, /data-view="release"/);
});

test("account settings expose source blacklists and a searchable ID directory", () => {
  assert.match(javascript, /屏蔽用户 wxid/);
  assert.match(javascript, /屏蔽群聊 ID/);
  assert.match(javascript, /source-blocked-senders/);
  assert.match(javascript, /source-blocked-groups/);
  assert.match(javascript, /function renderDirectory\(\)/);
  assert.match(javascript, /名称或 wxid/);
  assert.match(javascript, /data-action="sync-directory"/);
  assert.match(javascript, /data-action="copy-directory-id"/);
  assert.match(css, /\.directory-toolbar/);
});

test("admin header owns worker and auto reply controls", () => {
  assert.match(html, /id="worker-toggle"/);
  assert.match(html, /data-action="workers-toggle"/);
  assert.match(html, /id="auto-reply-toggle"/);
  assert.match(html, /data-action="auto-reply-toggle"/);
  assert.doesNotMatch(javascript, /data-action="workers-paused"/);
  assert.doesNotMatch(javascript, /id="case-auto-send"/);
  assert.doesNotMatch(javascript, /发送控制/);
  assert.doesNotMatch(javascript, /data-action="outbound-mode"/);
});

test("account settings expose an allowlist bypass that keeps group triggers", () => {
  assert.match(javascript, /id="\$\{id\}"/);
  assert.match(javascript, /忽略白名单/);
  assert.match(javascript, /source-ignore-allowlist/);
  assert.match(javascript, /系统账号、公众号和黑名单仍过滤/);
});

test("case workspace groups named sessions and reloads on runtime revision changes", () => {
  assert.match(html, /name="webot-runtime-revision"/);
  assert.match(javascript, /caseSessionOptions/);
  assert.match(javascript, /data-case-session/);
  assert.match(javascript, /class="case-session-select"/);
  assert.match(javascript, /reloadForRuntimeRevisionChange/);
  assert.match(javascript, /window\.location\.reload\(\)/);
});

test("case detail keeps Codex session usage above live progress", () => {
  assert.match(javascript, /Codex Live Progress/);
  assert.match(javascript, /waiting for first update/);
  assert.match(javascript, /codex-progress-item/);
  assert.match(javascript, /codex-session-summary/);
  assert.match(javascript, /Session Token/);
  assert.match(javascript, /估算消费/);
  assert.match(javascript, /reasoning_effort/);
  assert.match(css, /\.codex-progress-panel/);
  assert.match(css, /\.case-detail-head \{[^}]*flex: 0 0 auto/);
  assert.match(css, /\.case-detail-scroll \{[^}]*overflow-anchor: none/);
});

test("owner intermediate replies are described as private self conversations only", () => {
  assert.match(javascript, /本人私聊接收中间回复/);
  assert.match(javascript, /群聊及其他私聊不发送/);
});

test("assistant settings split Codex defaults between self chat and others", () => {
  assert.match(javascript, /自聊默认模型/);
  assert.match(javascript, /assistant-self-codex-model/);
  assert.match(javascript, /assistant-self-reasoning-effort/);
  assert.match(javascript, /其他人默认模型/);
  assert.match(javascript, /assistant-other-codex-model/);
  assert.match(javascript, /assistant-other-reasoning-effort/);
});

test("case list width is narrower, draggable, persistent, and mobile-safe", () => {
  assert.match(javascript, /caseListDefaultWidth = 300/);
  assert.match(javascript, /data-case-resizer/);
  assert.match(javascript, /setPointerCapture/);
  assert.match(javascript, /caseListWidthStorageKey/);
  assert.match(javascript, /window\.localStorage\.setItem/);
  assert.match(javascript, /event\.key === "ArrowLeft"/);
  assert.match(javascript, /event\.key === "ArrowRight"/);
  assert.match(css, /--case-list-width: 300px/);
  assert.match(css, /\.case-resizer \{[^}]*cursor: col-resize/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.case-resizer \{ display: none; \}/);
});

test("knowledge editing is independent and knowledge configuration lives in settings", () => {
  assert.match(javascript, /function renderKnowledge\(\)/);
  assert.match(javascript, /function knowledgeSettingsMarkup\(\)/);
  assert.match(javascript, /KB 路径与同步/);
  assert.match(javascript, /data-settings-fold="knowledge"/);
  assert.match(javascript, /\$\{knowledgeSettingsMarkup\(\)\}/);
  const knowledgeView = javascript.slice(
    javascript.indexOf("function renderKnowledge()"),
    javascript.indexOf("function renderSettings()"),
  );
  assert.doesNotMatch(knowledgeView, /KB 路径与同步/);
  assert.match(knowledgeView, /data-action="new-kb"/);
  assert.match(javascript, /data-settings-fold="accounts"/);
  assert.match(javascript, /data-settings-fold="agents"/);
  assert.match(javascript, /data-settings-fold="assistant"/);
  assert.doesNotMatch(
    javascript,
    /data-settings-fold="(?:accounts|knowledge|agents|assistant)"\s+open/,
  );
});
