import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

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

test("case detail distinguishes next model from past model and gates Clear while running", () => {
  const source = javascript.slice(javascript.indexOf("function renderCaseDetail("), javascript.indexOf("function renderCases("));
  const render = vm.runInNewContext(`${source}; renderCaseDetail`, {
    escapeHtml: (value) => String(value || ""), countText: String,
    costText: () => "0", panelOpen: () => false, badge: () => "", time: String,
  });
  const item = { case_id: "case", workerSession: { model: "company-gpt-6.1-sol" },
    nextRuntime: { model: "gpt-6.1-sol", modelSource: "session" } };
  const idle = render(item);
  assert.match(idle, /下次使用模型 · 会话覆盖<\/span>\s*<strong>gpt-6\.1-sol<\/strong>/);
  assert.match(idle, /上次运行模型<\/span>\s*<strong>company-gpt-6\.1-sol<\/strong>/);
  assert.match(idle, /data-action="clear-case"[^>]*><i/);
  const running = render({ ...item, workerSession: { ...item.workerSession, status: "running" } });
  assert.match(running, /data-action="clear-case"[^>]*disabled title="请先停止 Worker"/);
  const waiting = render({ ...item, status: "waiting", scheduledRunAt: 120_000 });
  assert.match(waiting, /自动运行：120000/);
  assert.match(waiting, /data-action="run-case"[^>]*>[\s\S]*?立即运行/);
  assert.match(waiting, /data-action="discard-case"/);
  assert.doesNotMatch(idle, /data-action="discard-case"/);
  assert.doesNotMatch(running, /data-action="discard-case"/);
});

test("Codex config file setting round-trips through the existing home setting", () => {
  const source = javascript.slice(javascript.indexOf("function codexConfigFile("), javascript.indexOf("function readAssistantForm("));
  const helpers = vm.runInNewContext(`${source}; ({codexConfigFile, codexHomeFromConfigFile})`);
  for (const home of ["/tmp/bot home", "/", "C:/bot", "C:/"]) {
    assert.equal(helpers.codexHomeFromConfigFile(helpers.codexConfigFile(home)), home);
  }
  assert.equal(helpers.codexHomeFromConfigFile(""), "");
  assert.throws(() => helpers.codexHomeFromConfigFile("config.toml"), /config.toml/);
  assert.throws(() => helpers.codexHomeFromConfigFile("/tmp/auth.json"), /config.toml/);
  assert.match(javascript, /assistant-codex-config-file/);
  assert.match(javascript, /escapeHtml\(codex\.configFile/);
});

function adminRequest(status, body) {
  const source = javascript.slice(
    javascript.indexOf("async function api("),
    javascript.indexOf("function sourceStatus("),
  );
  return vm.runInNewContext(`${source}; api`, {
    fetch: async () => new Response(JSON.stringify(body), { status }),
  });
}

function caseRefreshContext(api, focused = false) {
  const source = javascript.slice(
    javascript.indexOf("function caseSessionSelectFocused("),
    javascript.indexOf("async function reloadForRuntimeRevisionChange("),
  );
  const context = vm.createContext({
    api, caseSelectionRequest: 0, caseSelectionLoading: 0,
    selectedCase: { case_id: "old" }, cases: [], caseTotal: 0,
    caseHasMore: false, workers: {}, casePage: 0, casePageSize: 50,
    caseHistoryExpanded: new Map(), caseListResizing: false, casePointerSelecting: false, renders: 0,
    captureCaseViewState() {},
    document: { activeElement: { matches: () => focused } },
  });
  vm.runInContext(`${source}; function render() { renders++; }`, context);
  return context;
}

test("polling does not replace an open session dropdown", async () => {
  const context = caseRefreshContext(async () => ({ cases: [] }), true);
  await vm.runInContext("refreshCases()", context);
  assert.equal(context.renders, 0);
});

test("polling preserves dragging and selected case text, then resumes after the selection is cleared", async () => {
  let calls = 0;
  const context = caseRefreshContext(async () => { calls++; return { cases: [] }; });
  context.casePointerSelecting = true;
  await vm.runInContext("refreshCases()", context);
  assert.equal(calls, 0);
  context.casePointerSelecting = false;
  const textNode = { parentElement: { closest: (selector) => selector === ".case-workspace" } };
  context.document.getSelection = () => ({ isCollapsed: false, anchorNode: textNode, focusNode: textNode });
  await vm.runInContext("refreshCases()", context);
  assert.equal(calls, 0);
  context.document.getSelection = () => ({ isCollapsed: true });
  await vm.runInContext("refreshCases()", context);
  assert.equal(calls, 1);
  assert.equal(context.renders, 1);
});

test("a selection created during an in-flight poll prevents its redraw", async () => {
  let resolveList;
  const context = caseRefreshContext(() => new Promise((resolve) => { resolveList = resolve; }));
  const pending = vm.runInContext("refreshCases()", context);
  context.document.getSelection = () => ({ isCollapsed: false,
    anchorNode: { nodeType: 1, closest: () => true } });
  resolveList({ cases: [] });
  await pending;
  assert.equal(context.renders, 0);
});

test("an old polling detail response cannot overwrite a newer session selection", async () => {
  let resolveDetail;
  const context = caseRefreshContext(async (path) => {
    if (path.startsWith("/api/admin/cases?")) return { cases: [] };
    return new Promise((resolve) => { resolveDetail = resolve; });
  });
  const pending = vm.runInContext("refreshCases(true)", context);
  await new Promise((resolve) => setImmediate(resolve));
  context.caseSelectionRequest++;
  context.selectedCase = { case_id: "qw3" };
  resolveDetail({ case: { case_id: "old" } });
  await pending;
  assert.equal(context.selectedCase.case_id, "qw3");
  assert.equal(context.renders, 0);
});

test("an old polling list response cannot re-render during session selection", async () => {
  let resolveList;
  const context = caseRefreshContext(() => new Promise((resolve) => {
    resolveList = resolve;
  }));
  const pending = vm.runInContext("refreshCases()", context);
  context.caseSelectionRequest++;
  resolveList({ cases: [{ case_id: "old" }] });
  await pending;
  assert.equal(context.cases.length, 0);
  assert.equal(context.renders, 0);
});

test("offline channel status remains readable by admin initialization and polling", async () => {
  const snapshot = {
    ok: false,
    service: "webot",
    padSources: [{ id: "fixture", ready: false }],
  };
  const request = adminRequest(200, snapshot);
  const result = await request("/api/admin/status");
  assert.equal(result.ok, false);
  assert.equal(result.padSources[0].ready, false);
  assert.equal(result.service, "webot");
});

test("admin status exceptions do not suppress HTTP or other API errors", async () => {
  await assert.rejects(
    adminRequest(503, { ok: false, error: "unavailable" })("/api/admin/status"),
    /unavailable/,
  );
  await assert.rejects(
    adminRequest(200, { ok: false, error: "invalid settings" })("/api/admin/settings"),
    /invalid settings/,
  );
  assert.equal((await adminRequest(200, { ok: true })("/api/admin/status")).ok, true);
});

test("admin navigation exposes cases, captured messages, ID directory, knowledge, and settings", () => {
  assert.match(html, /data-view="cases"/);
  assert.match(html, /data-view="captured"/);
  assert.match(html, /data-view="directory"/);
  assert.match(html, /data-view="knowledge"/);
  assert.match(html, /data-view="settings"/);
  assert.doesNotMatch(html, /data-view="overview"/);
  assert.doesNotMatch(html, /data-view="release"/);
});

test("captured monitor exposes all Pad messages with filters and pagination", () => {
  assert.match(javascript, /function renderCaptured\(\)/);
  assert.match(javascript, /\/api\/admin\/captured/);
  assert.match(javascript, /全部结果/);
  assert.match(javascript, /已进入 Case/);
  assert.match(javascript, /data-action="captured-prev"/);
  assert.match(javascript, /data-action="captured-next"/);
  assert.match(css, /\.captured-toolbar/);
  assert.match(css, /\.captured-table/);
});

function capturedReplayContext(overrides = {}) {
  const source = javascript.slice(
    javascript.indexOf("async function replayCaptured("),
    javascript.indexOf("async function loadCaptured("),
  );
  return vm.createContext({
    message: { id: 1, source_id: "small", message_id: "6415032614165678096", accepted: false },
    capturedReplaying: new Set(),
    activeView: "captured",
    confirms: 0,
    requests: [],
    notices: [],
    renders: 0,
    confirm() { this.confirms++; return true; },
    render() {},
    loadCaptured: async () => {},
    showNotice() {},
    ...overrides,
    replaySource: source,
  });
}

test("captured replay controls render at the end of each row with duplicate protection", () => {
  assert.match(javascript, /data-action="captured-replay"/);
  assert.match(javascript, /data-lucide="rotate-ccw"/);
  assert.match(javascript, /data-captured-id/);
  assert.match(javascript, /message.accepted === true \|\| capturedReplaying.has\(message.id\)/);
  assert.match(javascript, /colspan="7"/);
  assert.match(css, /\.captured-actions button \{ width: 30px; height: 30px;/);
});

test("captured replay confirms and posts exact IDs while blocking double clicks", async () => {
  let finish;
  let confirmations = 0;
  const requests = [];
  const notices = [];
  const context = capturedReplayContext({
    confirm: () => { confirmations++; return true; },
    api: async (path, options) => {
      requests.push({ path, body: JSON.parse(options.body) });
      return new Promise((resolve) => { finish = resolve; });
    },
    showNotice: (message) => notices.push(message),
  });
  vm.runInContext(context.replaySource, context);
  const pending = vm.runInContext("replayCaptured(message)", context);
  assert.equal(context.capturedReplaying.has(1), true);
  await vm.runInContext("replayCaptured(message)", context);
  assert.equal(confirmations, 1);
  assert.deepEqual(requests, [{
    path: "/api/admin/captured/replay",
    body: { sourceId: "small", messageId: "6415032614165678096" },
  }]);
  finish({ accepted: true, queued: true });
  await pending;
  assert.equal(context.capturedReplaying.size, 0);
  assert.equal(context.message.accepted, true);
  assert.match(notices[0], /处理队列/);
});

test("cancelled, accepted, filtered, and failed replay controls retain usable state", async () => {
  for (const mode of ["cancelled", "accepted", "filtered", "failed"]) {
    let requests = 0;
    const notices = [];
    const context = capturedReplayContext({
      confirm: () => mode !== "cancelled",
      api: async () => {
        requests++;
        if (mode === "failed") throw new Error("offline");
        return { accepted: false, reason: "chat-not-allowed" };
      },
      showNotice: (...notice) => notices.push(notice),
    });
    if (mode === "accepted") context.message.accepted = true;
    vm.runInContext(context.replaySource, context);
    const result = vm.runInContext("replayCaptured(message)", context);
    if (mode === "failed") await assert.rejects(result, /offline/);
    else await result;
    assert.equal(context.capturedReplaying.size, 0);
    assert.equal(requests, ["cancelled", "accepted"].includes(mode) ? 0 : 1);
    if (mode === "filtered") {
      assert.equal(context.message.decision, "chat-not-allowed");
      assert.match(notices[0][0], /仍被过滤/);
      assert.equal(notices[0][1], true);
    }
  }
});

test("account settings expose source blacklists and a searchable ID directory", () => {
  assert.match(javascript, /屏蔽用户 wxid/);
  assert.match(javascript, /屏蔽群聊 ID/);
  assert.match(javascript, /source-blocked-senders/);
  assert.match(javascript, /source-blocked-groups/);
  assert.match(javascript, /function renderDirectory\(\)/);
  assert.match(javascript, /名称或 wxid/);
  assert.match(javascript, /data-action="sync-directory"/);
  assert.match(javascript, /directorySyncing/);
  assert.match(javascript, /通讯录同步已开始/);
  assert.match(javascript, /同步完成：发现/);
  assert.match(javascript, /role="status" aria-live="polite"/);
  assert.match(javascript, /data-action="copy-directory-id"/);
  assert.match(css, /\.directory-toolbar/);
  assert.match(css, /\.directory-sync-status/);
  assert.match(css, /@keyframes directory-spin/);
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

test("version area exposes an idle auto-update restart control", () => {
  assert.match(html, /id="runtime-build"[\s\S]*id="auto-update-button"/);
  assert.match(html, /自动更新重启/);
  assert.match(javascript, /requestConsoleRestart\("idle"\)/);
  assert.match(javascript, /body: JSON\.stringify\(\{ confirm: true, mode \}\)/);
  assert.match(javascript, /任务空闲后自动更新并重启 Webot/);
});

test("account settings expose an allowlist bypass that keeps group triggers", () => {
  assert.match(javascript, /id="\$\{id\}"/);
  assert.match(javascript, /忽略白名单/);
  assert.match(javascript, /source-ignore-allowlist/);
  assert.match(javascript, /系统账号、公众号和黑名单仍过滤/);
});

test("account settings expose a saved channel activation command and keyword-only policy", () => {
  assert.match(javascript, /data-action="toggle-source"/);
  assert.match(javascript, /data-lucide="power"/);
  assert.match(javascript, /\/api\/admin\/opt\/enabled/);
  assert.match(javascript, /body: JSON\.stringify\(\{ sourceId: source\.id, enabled: !source\.enabled \}\)/);
  assert.match(javascript, /通道配置已保存，任务空闲时生效；新任务继续处理/);
  assert.match(javascript, /nextStatus\.restart\?\.error/);
  assert.match(javascript, /source-keyword-only/);
  assert.match(javascript, /keywordOnly: document\.querySelector\("#source-keyword-only"\)\.checked/);
  assert.match(javascript, /source-self-without-prefix/);
  assert.match(javascript, /selfChatWithoutPrefix: document\.querySelector\("#source-self-without-prefix"\)\.checked/);
});

test("case workspace groups named sessions and reloads on runtime revision changes", () => {
  assert.match(html, /name="webot-runtime-revision"/);
  assert.match(javascript, /caseSessionOptions/);
  assert.match(javascript, /data-case-session/);
  assert.match(javascript, /class="case-session-select"/);
  assert.match(javascript, /reloadForRuntimeRevisionChange/);
  assert.match(javascript, /window\.location\.reload\(\)/);
  assert.match(javascript, /webot-case-session-selections/);
  assert.match(javascript, /window\.localStorage\.setItem/);
  assert.match(javascript, /caseSelectionLoading/);
  assert.match(javascript, /!caseSelectionLoading/);
});

test("a reloaded revision refreshes the console even while an unrelated account is offline", async () => {
  const source = javascript.slice(
    javascript.indexOf("async function reloadForRuntimeRevisionChange("),
    javascript.indexOf("window.setInterval(", javascript.indexOf("async function reloadForRuntimeRevisionChange(")),
  );
  for (const [revision, startedAt, service, expected] of [
    ["new", 2, "webot", 1],
    ["old", 2, "webot", 0],
    ["new", 1, "webot", 0],
    ["new", 2, "other", 0],
  ]) {
    let reloads = 0;
    const context = vm.createContext({
      api: async () => ({
        ok: false, service, runtime: { sourceRevision: revision, startedAt },
        restart: {}, ingress: { degradedSourceIds: ["pad:offline"] },
      }),
      restartStartedAt: 1, restartExpectedRevision: "new",
      dirty: false, knowledgeDirty: false, agentDirty: false,
      status: {}, pageRuntimeRevision: "old", runtimeUpdateNoticeRevision: "",
      window: { location: { reload() { reloads++; } } },
      showNotice() {}, renderRuntimeIdentity() {},
    });
    await vm.runInContext(`${source}; reloadForRuntimeRevisionChange()`, context);
    assert.equal(reloads, expected);
  }
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

test("completed drafts are explicitly marked apart from live progress", () => {
  assert.match(javascript, /class="draft-done-marker">\[done\]<\/span>/);
  assert.match(css, /\.draft-done-marker/);
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
