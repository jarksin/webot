import {
  Activity,
  BookOpen,
  Cloud,
  Eye,
  FileText,
  Inbox,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  Trash2,
  UserRound,
  Users,
  createIcons,
} from "lucide";

const iconSet = {
  Activity,
  BookOpen,
  Cloud,
  Eye,
  FileText,
  Inbox,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  Trash2,
  UserRound,
  Users,
};

const views = {
  cases: ["CASES", "微信 Case"],
  knowledge: ["KNOWLEDGE", "知识库"],
  settings: ["CONFIG", "设置"],
};

let activeView = views[location.hash.slice(1)]
  ? location.hash.slice(1)
  : "cases";
let settings = null;
let status = null;
let selectedSource = 0;
let dirty = false;
let cases = [];
let workers = {};
let selectedCase = null;
let casePage = 0;
let caseTotal = 0;
let caseHasMore = false;
const casePageSize = 50;
const caseListWidthStorageKey = "webot-case-list-width";
const caseListDefaultWidth = 300;
const caseListMinWidth = 240;
const caseListMaxWidth = 520;
const caseDetailMinWidth = 420;
const caseResizerWidth = 8;
const pageRuntimeRevision =
  document.querySelector('meta[name="webot-runtime-revision"]')?.content || "";
let runtimeUpdateNoticeRevision = "";
const caseHistoryExpanded = new Map();
const caseViewStates = new Map();
const caseSessionSelections = new Map();
let caseListResizing = false;
let caseWorkspaceResizeObserver = null;
let agentDocument = null;
let agentDirty = false;
const settingsFoldOpen = new Set();
let knowledgeDocuments = [];
let selectedKnowledge = null;
let knowledgeDirty = false;
let knowledgeMode = "source";

const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const saveState = document.querySelector("#save-state");

function icons() {
  createIcons({ icons: iconSet, attrs: { "stroke-width": 1.8 } });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function listText(value) {
  return (Array.isArray(value) ? value : []).join("\n");
}

function parseList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function time(value) {
  if (!value) return "尚无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function badge(label, tone = "") {
  return `<span class="badge ${tone}"><span class="status-dot ${tone === "good" ? "ok" : ""}"></span>${escapeHtml(label)}</span>`;
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.remove("hidden");
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => notice.classList.add("hidden"), 4200);
}

function renderMarkdown(value) {
  const lines = String(value || "").split(/\r?\n/);
  const output = [];
  let inCode = false;
  let code = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      output.push(`<p class="preview-list">• ${escapeHtml(line.replace(/^\s*[-*]\s+/, ""))}</p>`);
    } else if (line.trim()) {
      output.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (code.length) {
    output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  return output.join("") || `<div class="empty compact"><div>暂无内容</div></div>`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function sourceStatus(source) {
  return status?.padSources?.find((item) => item.id === source.id);
}

function caseTone(value) {
  if (value === "replied") return "good";
  if (value === "failed" || value === "stopped") return "bad";
  if (value === "running" || value === "draft_ready") return "warn";
  return "";
}

function caseStatusLabel(value) {
  return {
    new: "待处理",
    running: "处理中",
    draft_ready: "待发送",
    replied: "已回复",
    failed: "失败",
    stopped: "已停止",
    draft: "草稿",
    sent: "已发送",
  }[value] || value || "未运行";
}

function caseRootId(item) {
  return item?.namedSession?.scopeCaseId || item?.case_id || "";
}

function caseSessionTarget(item) {
  const options = item.caseSessionOptions || [];
  const rootCaseId = caseRootId(item);
  const stored = caseSessionSelections.get(rootCaseId);
  if (stored && options.some((option) => option.targetCaseId === stored && option.exists)) {
    return stored;
  }
  if (
    selectedCase &&
    caseRootId(selectedCase) === rootCaseId &&
    options.some((option) => option.targetCaseId === selectedCase.case_id)
  ) {
    return selectedCase.case_id;
  }
  return (
    options.find((option) => option.active && option.exists)?.targetCaseId ||
    options.find((option) => option.key === "main" && option.exists)?.targetCaseId ||
    item.case_id
  );
}

function caseSessionSummary(item, targetCaseId) {
  return (
    (item.caseSessionOptions || []).find(
      (option) => option.targetCaseId === targetCaseId,
    ) || null
  );
}

function captureCaseViewState() {
  if (!selectedCase) return;
  const scroll = document.querySelector(".case-detail-scroll");
  const panels = [...document.querySelectorAll("[data-case-panel]")];
  caseViewStates.set(selectedCase.case_id, {
    scrollTop: scroll?.scrollTop || 0,
    knownPanels: panels.map((panel) => panel.dataset.casePanel),
    openPanels: panels
      .filter((panel) => panel.open)
      .map((panel) => panel.dataset.casePanel),
  });
}

function panelOpen(caseId, panel, fallback = false) {
  const state = caseViewStates.get(caseId);
  if (!state?.knownPanels?.includes(panel)) return fallback;
  return state.openPanels.includes(panel);
}

function restoreCaseViewState(caseId) {
  const state = caseViewStates.get(caseId);
  const scroll = document.querySelector(".case-detail-scroll");
  if (!state || !scroll) return;
  requestAnimationFrame(() => {
    scroll.scrollTop = state.scrollTop;
  });
}

function renderCaseDetail(item) {
  const session = item.workerSession || {};
  const window = item.displayWindow || {};
  const running = session.status === "running";
  const liveProgress = (item.progress || []).filter(
    (entry) => entry.level === "live",
  );
  const progressPanel = "codex-progress";
  const windowText = [
    `消息 ${Number(window.messageShown || item.messages?.length || 0)} / ${Number(window.messageTotal || item.messages?.length || 0)}`,
    `草稿 ${Number(window.draftShown || item.drafts?.length || 0)} / ${Number(window.draftTotal || item.drafts?.length || 0)}`,
  ].join(" · ");
  return `
    <div class="case-detail-head">
      <div class="case-detail-title">
        <h2>${escapeHtml(item.title)}</h2>
        ${item.namedSession
          ? `<span class="case-session-label">Session: ${escapeHtml(item.namedSession.name)}${item.namedSession.active ? " · active" : ""}</span>`
          : ""}
        <p class="mono">${escapeHtml(item.case_id)}</p>
      </div>
      <div class="inline-actions">
        ${running
          ? `<button class="button danger" data-action="stop-case" data-case-id="${escapeHtml(item.case_id)}">停止 Worker</button>`
          : `<button class="button secondary" data-action="run-case" data-case-id="${escapeHtml(item.case_id)}"><i data-lucide="play"></i><span>运行</span></button>`}
      </div>
    </div>
    <div class="case-detail-scroll">
      <div class="case-window">
        <span>${escapeHtml(windowText)}</span>
        ${(window.messageTruncated || window.draftTruncated || window.progressTruncated || window.expanded)
          ? `<button class="button secondary compact-button" data-action="case-history" data-case-id="${escapeHtml(item.case_id)}" data-expanded="${window.expanded ? "1" : "0"}">${window.expanded ? "收起历史" : "展开历史"}</button>`
          : ""}
      </div>
      ${item.last_error ? `<div class="case-error">${escapeHtml(item.last_error)}</div>` : ""}
      ${(running || liveProgress.length)
        ? `<details class="case-panel codex-progress-panel" data-case-panel="${progressPanel}" ${panelOpen(item.case_id, progressPanel, running) ? "open" : ""}>
            <summary>
              <span><strong>Codex Live Progress</strong><small>${liveProgress.length ? `${liveProgress.length} updates` : "waiting for first update"}</small></span>
              ${badge(running ? "running" : "last run", running ? "warn" : "")}
            </summary>
            <div class="case-panel-body codex-progress-list">
              ${liveProgress.length
                ? liveProgress.map((entry) => `
                    <div class="codex-progress-item">
                      <div class="codex-progress-meta">
                        <span>${time(entry.created_at)}</span>
                        <code>run ${Number(entry.run_count || 0)} · #${Number(entry.id || 0)}</code>
                      </div>
                      <p>${escapeHtml(entry.message)}</p>
                    </div>
                  `).join("")
                : `<div class="case-muted">Worker 已启动，等待 Codex 第一条中间进展。</div>`}
            </div>
          </details>`
        : ""}
      <div class="case-section-head"><h3>回复草稿</h3><span>${Number(window.draftTotal || item.drafts?.length || 0)} 条</span></div>
      <div class="draft-list">
        ${(item.drafts || []).map((draft) => {
          const panel = `draft-${draft.id}`;
          return `
          <details class="case-panel draft-panel" data-case-panel="${panel}" ${panelOpen(item.case_id, panel) ? "open" : ""}>
            <summary>
              <span><strong>${draft.status === "sent" ? "已发送回复" : "回复草稿"} #${Number(draft.id)}</strong><small>${escapeHtml(draft.model || "未记录模型")} · ${time(draft.created_at)}</small></span>
              ${badge(caseStatusLabel(draft.status), draft.status === "sent" ? "good" : "warn")}
            </summary>
            <div class="case-panel-body">
              <div class="draft-actions">
                <span>${draft.sent_at ? `发送于 ${time(draft.sent_at)}` : "尚未发送"}</span>
                ${draft.status !== "sent" ? `<button class="button primary" data-action="send-draft" data-case-id="${escapeHtml(item.case_id)}" data-draft-id="${Number(draft.id)}"><i data-lucide="send"></i><span>发送</span></button>` : ""}
              </div>
              <div class="draft-text">${escapeHtml(draft.text)}</div>
            </div>
          </details>`;
        }).join("") || `<div class="case-muted">暂无 draft</div>`}
      </div>
      <details class="case-panel message-panel" data-case-panel="messages" ${panelOpen(item.case_id, "messages") ? "open" : ""}>
        <summary>
          <span><strong>消息上下文</strong><small>${Number(window.messageShown || item.messages?.length || 0)} / ${Number(window.messageTotal || item.messages?.length || 0)} 条</small></span>
          ${badge(`${Number(window.messageTotal || item.messages?.length || 0)} 条`)}
        </summary>
        <div class="case-panel-body message-list">
          ${(item.messages || []).map((message) => `
            <div class="message-row ${message.direction === "outgoing" ? "outgoing" : ""}">
              <div><strong>${escapeHtml(message.sender_name || message.sender_id)}</strong><span>${time(message.timestamp)}</span></div>
              <p>${escapeHtml(message.text)}</p>
            </div>
          `).join("") || `<div class="case-muted">暂无消息</div>`}
        </div>
      </details>
    </div>`;
}

function renderCases() {
  const start = caseTotal ? casePage * casePageSize + 1 : 0;
  const end = caseTotal ? Math.min(start + cases.length - 1, caseTotal) : 0;
  content.innerHTML = `
    <div class="case-workspace">
      <section class="case-list-pane">
        <div class="case-toolbar">
          <div>
            <strong>${caseTotal} 个 Case</strong>
            <span>${Number(workers.active || 0)} 运行 · ${Number(workers.queued || 0)} 排队</span>
          </div>
        </div>
        <div class="case-list">
          ${cases.map((item) => {
            const targetCaseId = caseSessionTarget(item);
            const summary = caseSessionSummary(item, targetCaseId);
            const itemStatus = summary?.caseStatus || item.status;
            const active = selectedCase && caseRootId(selectedCase) === item.case_id;
            const sessionOptions = item.caseSessionOptions || [];
            return `
              <div class="case-item ${active ? "active" : ""}">
                <button class="case-item-main" data-case-select="${escapeHtml(targetCaseId)}">
                  <span class="case-item-head"><strong>${escapeHtml(item.title)}</strong>${badge(caseStatusLabel(itemStatus), caseTone(itemStatus))}</span>
                  <span class="case-preview">${escapeHtml(summary?.lastMessage || item.last_message || "")}</span>
                  <span class="case-meta">${escapeHtml(item.source_name)} · ${time(summary?.lastMessageAt || item.last_message_at)} · ${Number(summary?.draftCount ?? item.draft_count ?? 0)} drafts</span>
                </button>
                ${sessionOptions.length > 1
                  ? `<label class="case-session-control">
                      <span>Session</span>
                      <select class="case-session-select" data-case-session="${escapeHtml(item.case_id)}" aria-label="${escapeHtml(item.title)} Session">
                        ${sessionOptions.map((option) => `
                          <option value="${escapeHtml(option.targetCaseId)}" ${option.targetCaseId === targetCaseId ? "selected" : ""} ${option.exists ? "" : "disabled"}>
                            ${escapeHtml(option.name)}${option.active ? " · active" : ""}${option.caseStatus ? ` · ${escapeHtml(caseStatusLabel(option.caseStatus))}` : ""}
                          </option>
                        `).join("")}
                      </select>
                    </label>`
                  : ""}
              </div>`;
          }).join("") || `<div class="empty compact"><div>尚无微信 Case</div></div>`}
        </div>
        <div class="case-pagination">
          <button class="button secondary compact-button" data-action="case-prev" ${casePage <= 0 ? "disabled" : ""}>上一页</button>
          <span>${start}-${end} / ${caseTotal}</span>
          <button class="button secondary compact-button" data-action="case-next" ${caseHasMore ? "" : "disabled"}>下一页</button>
        </div>
      </section>
      <div
        class="case-resizer"
        data-case-resizer
        role="separator"
        aria-label="调整 Case 列表宽度"
        aria-orientation="vertical"
        aria-valuemin="${caseListMinWidth}"
        aria-valuemax="${caseListMaxWidth}"
        tabindex="0"
      ></div>
      <section class="case-detail-pane">
        ${selectedCase
          ? renderCaseDetail(selectedCase)
          : `<div class="empty case-empty"><div><i data-lucide="inbox"></i><div>选择一个 Case</div></div></div>`}
      </section>
    </div>`;
}

function storedCaseListWidth() {
  try {
    return Number(window.localStorage.getItem(caseListWidthStorageKey)) || caseListDefaultWidth;
  } catch {
    return caseListDefaultWidth;
  }
}

function caseListWidthBounds(workspace) {
  const available = workspace.clientWidth - caseResizerWidth - caseDetailMinWidth;
  return {
    min: caseListMinWidth,
    max: Math.max(caseListMinWidth, Math.min(caseListMaxWidth, available)),
  };
}

function setCaseListWidth(workspace, width, persist = false) {
  const bounds = caseListWidthBounds(workspace);
  const nextWidth = Math.round(
    Math.min(bounds.max, Math.max(bounds.min, Number(width) || caseListDefaultWidth)),
  );
  workspace.style.setProperty("--case-list-width", `${nextWidth}px`);
  const resizer = workspace.querySelector("[data-case-resizer]");
  if (resizer) {
    resizer.setAttribute("aria-valuenow", String(nextWidth));
    resizer.setAttribute("aria-valuemax", String(bounds.max));
  }
  if (persist) {
    try {
      window.localStorage.setItem(caseListWidthStorageKey, String(nextWidth));
    } catch {
      // The layout remains adjustable when browser storage is unavailable.
    }
  }
  return nextWidth;
}

function initializeCaseResize() {
  caseWorkspaceResizeObserver?.disconnect();
  caseWorkspaceResizeObserver = null;
  const workspace = content.querySelector(".case-workspace");
  const resizer = workspace?.querySelector("[data-case-resizer]");
  if (!workspace || !resizer || window.matchMedia("(max-width: 680px)").matches) return;

  setCaseListWidth(workspace, storedCaseListWidth());
  let pointerId = null;

  const finishResize = () => {
    if (pointerId === null) return;
    pointerId = null;
    caseListResizing = false;
    workspace.classList.remove("resizing");
    document.body.classList.remove("case-resizing");
    setCaseListWidth(
      workspace,
      Number.parseInt(workspace.style.getPropertyValue("--case-list-width"), 10),
      true,
    );
  };

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    caseListResizing = true;
    workspace.classList.add("resizing");
    document.body.classList.add("case-resizing");
    resizer.setPointerCapture(pointerId);
  });
  resizer.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    setCaseListWidth(workspace, event.clientX - workspace.getBoundingClientRect().left);
  });
  resizer.addEventListener("pointerup", finishResize);
  resizer.addEventListener("pointercancel", finishResize);
  resizer.addEventListener("dblclick", () => {
    setCaseListWidth(workspace, caseListDefaultWidth, true);
  });
  resizer.addEventListener("keydown", (event) => {
    const current = Number.parseInt(
      workspace.style.getPropertyValue("--case-list-width"),
      10,
    );
    const bounds = caseListWidthBounds(workspace);
    let nextWidth = current;
    if (event.key === "ArrowLeft") nextWidth -= 16;
    else if (event.key === "ArrowRight") nextWidth += 16;
    else if (event.key === "Home") nextWidth = bounds.min;
    else if (event.key === "End") nextWidth = bounds.max;
    else return;
    event.preventDefault();
    setCaseListWidth(workspace, nextWidth, true);
  });

  caseWorkspaceResizeObserver = new ResizeObserver(() => {
    setCaseListWidth(workspace, storedCaseListWidth());
  });
  caseWorkspaceResizeObserver.observe(workspace);
}

function field(label, id, value, options = {}) {
  const full = options.full ? " full" : "";
  const type = options.type || "text";
  const note = options.note ? `<small>${escapeHtml(options.note)}</small>` : "";
  if (options.textarea) {
    return `<div class="field${full}"><label for="${id}"><span>${label}</span>${note}</label><textarea id="${id}" data-dirty>${escapeHtml(value)}</textarea></div>`;
  }
  return `<div class="field${full}"><label for="${id}"><span>${label}</span>${note}</label><input class="input" id="${id}" type="${type}" value="${escapeHtml(value)}" ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""} data-dirty></div>`;
}

function toggle(label, id, checked, detail) {
  return `<div class="toggle-row"><div class="toggle-copy"><strong>${label}</strong><span>${detail}</span></div><label class="switch"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} data-dirty><span></span></label></div>`;
}

function accountsMarkup() {
  const sources = settings.pad.sources || [];
  const source = sources[selectedSource];
  return `
    <details class="settings-card settings-fold" data-settings-fold="accounts" ${settingsFoldOpen.has("accounts") ? "open" : ""}>
      <summary><span><strong>账号列表</strong><small>${sources.length} 个接入账号</small></span></summary>
      <div class="settings-card-body">
        <div class="section-head"><div><h2>微信账号</h2><p>接入、监听与触发配置</p></div><button class="button secondary" data-action="add-source"><i data-lucide="plus"></i><span>添加账号</span></button></div>
        <div class="split-layout">
          <div class="account-list">
            ${sources.map((item, index) => `<button class="account-item ${index === selectedSource ? "active" : ""}" data-source-index="${index}">
              <span class="account-avatar"><i data-lucide="user-round"></i></span>
              <span class="account-copy"><strong>${escapeHtml(item.displayName || item.id)}</strong><span>${escapeHtml(item.selfId || "未填写 wxid")}</span></span>
            </button>`).join("")}
          </div>
          <div class="editor">${source ? accountEditor(source) : `<div class="empty"><div><i data-lucide="users"></i><div>添加一个微信账号</div></div></div>`}</div>
        </div>
      </div>
    </details>`;
}

function accountEditor(source) {
  const current = sourceStatus(source);
  const wsPort = (() => {
    try { return new URL(source.wsUrl).port; } catch { return ""; }
  })();
  return `
    <div class="form-section">
      <div class="section-head"><div><h2>账号信息</h2><p>${current?.health?.lastError ? escapeHtml(current.health.lastError) : current?.health?.ready ? "连接正常" : "等待检测"}</p></div>
        <div class="inline-actions"><button class="button secondary" data-action="test-source"><i data-lucide="activity"></i><span>检测连接</span></button><button class="button danger icon-only" data-action="delete-source" title="删除账号"><i data-lucide="trash-2"></i></button></div>
      </div>
      <div class="form-grid">
        ${field("显示名称", "source-name", source.displayName)}
        ${field("配置 ID", "source-id", source.id)}
        ${field("微信 wxid", "source-wxid", source.selfId, { full: true })}
      </div>
    </div>
    <div class="form-section">
      <div class="section-head"><div><h2>WeChatPad 网关</h2><p>每个账号使用独立凭据和 WebSocket</p></div></div>
      <div class="form-grid three">
        ${field("网关 API", "source-api", source.apiUrl, { full: true, placeholder: "http://127.0.0.1:18102/api" })}
        ${field("网关 WS 端口", "source-ws-port", wsPort, { type: "number", placeholder: "18102" })}
        ${field("WebSocket 地址", "source-ws", source.wsUrl, { full: true, placeholder: "ws://127.0.0.1:18102/ws/wxid" })}
        ${field("Access Code", "source-token", "", { type: "password", note: source.accessTokenConfigured ? "已配置" : "" })}
        ${field("Access Code 文件", "source-token-file", source.accessTokenFile, { full: true })}
      </div>
      ${toggle("启用账号", "source-enabled", source.enabled, "参与消息监听与回复")}
    </div>
    <div class="form-section">
      <h2>监听与触发规则</h2>
      <div class="form-grid">
        ${field("允许私聊 wxid", "source-senders", listText(source.allowedSenderIds), { textarea: true })}
        ${field("允许私聊昵称", "source-nicknames", listText(source.privateNicknameAllowlist), { textarea: true })}
        ${field("监听群聊 ID", "source-groups", listText(source.allowedChatIds), { textarea: true })}
        ${field("群触发词", "source-triggers", listText(source.triggerKeywords), { textarea: true })}
        ${field("机器人名称", "source-bot-names", listText(source.botNames), { textarea: true })}
        ${field("关联自有账号", "source-peers", listText(source.selfChatPeers), { textarea: true })}
      </div>
      ${toggle("允许账号自聊", "source-allow-self", source.allowSelf, "处理发送给同一账号的消息")}
      ${toggle("接收关联账号入站", "source-accept-peers", source.acceptSelfChatPeerMessages, "仅处理关联账号发来的入站副本")}
    </div>`;
}

function assistantMarkup() {
  const assistant = settings.assistant;
  const caseManagement = settings.caseManagement || {};
  const codex = status.codex || {};
  const effective = codex.effective || {};
  return `
    <details class="settings-card settings-fold" data-settings-fold="agents" ${settingsFoldOpen.has("agents") ? "open" : ""}>
      <summary><span><strong>AGENTS.md</strong><small>${escapeHtml(agentDocument?.path || status.agentFile || "当前工作目录")}</small></span></summary>
      <div class="settings-card-body">
        <div class="section-head"><div><h2>身份与权限</h2><p>当前实例的最高层个人策略</p></div><button class="button primary" data-action="save-agent" ${agentDirty ? "" : "disabled"}><i data-lucide="save"></i><span>保存</span></button></div>
        <textarea id="agent-editor" class="document-editor" spellcheck="false">${escapeHtml(agentDocument?.content || "")}</textarea>
        <p class="editor-note">System Prompt、Skill 和 KB 可以补充，但不能扩大这里的权限。</p>
      </div>
    </details>
    <details class="settings-card settings-fold" data-settings-fold="assistant" ${settingsFoldOpen.has("assistant") ? "open" : ""}>
      <summary><span><strong>助手后端</strong><small>当前模式：${escapeHtml(assistant.mode)}</small></span></summary>
      <div class="settings-card-body">
        <div class="form-grid three">
          <div class="field"><label for="assistant-mode">运行模式</label><select id="assistant-mode" data-dirty>
            <option value="codex" ${assistant.mode === "codex" ? "selected" : ""}>本机 Codex</option>
            <option value="echo" ${assistant.mode === "echo" ? "selected" : ""}>Echo</option>
            <option value="webhook" ${assistant.mode === "webhook" ? "selected" : ""}>Webhook</option>
            <option value="openai-compatible" ${assistant.mode === "openai-compatible" ? "selected" : ""}>OpenAI Compatible</option>
          </select></div>
          ${field("历史轮数", "assistant-history", assistant.historyTurns, { type: "number" })}
          ${field("Worker 超时（毫秒）", "assistant-timeout", assistant.timeoutMs, { type: "number", note: "0 表示不限制" })}
          ${field("Codex 可执行文件", "assistant-codex-bin", assistant.codexBin || codex.binary, { full: true })}
          ${field("CODEX_HOME", "assistant-codex-home", assistant.codexHome || codex.home, { full: true })}
          ${field("工作目录", "assistant-working-directory", assistant.workingDirectory || effective.workingDirectory, { full: true })}
          ${field("Codex 模型", "assistant-codex-model", assistant.codexModel || effective.model, { note: "留空则继承本机配置" })}
          ${field("Reasoning Effort", "assistant-reasoning-effort", assistant.reasoningEffort || effective.reasoningEffort, { note: "low / medium / high / xhigh" })}
          ${field("Service Tier", "assistant-service-tier", assistant.serviceTier || effective.serviceTier, { note: "standard / priority / flex" })}
          ${field("LLM Base URL", "assistant-base-url", assistant.llmBaseUrl, { full: true })}
          ${field("OpenAI Compatible 模型", "assistant-model", assistant.llmModel)}
          ${field("API Key", "assistant-api-key", "", { type: "password", note: assistant.llmApiKeyConfigured ? "已配置" : "" })}
          ${field("Webhook URL", "assistant-webhook-url", assistant.webhookUrl, { full: true })}
          ${field("Webhook Token", "assistant-webhook-token", "", { type: "password", note: assistant.webhookTokenConfigured ? "已配置" : "" })}
          ${field("System Prompt", "assistant-prompt", assistant.systemPrompt, { textarea: true, full: true, note: "Codex 模式下作为 developer_instructions 生效" })}
        </div>
        <div class="release-row"><span>本机配置</span><strong>${codex.configPresent ? "已读取" : "未找到"} · ${codex.authPresent ? "认证已就绪" : "认证未就绪"}</strong></div>
        <div class="release-row"><span>配置更新时间</span><code>${escapeHtml(codex.configMtime || "未知")}</code></div>
      </div>
    </details>
    <div class="section settings-card">
      <div class="section-head"><div><h2>Case 自动化</h2><p>入站先形成 Case，再由 worker 生成 draft</p></div></div>
      ${toggle("自动运行 Worker", "case-auto-run", caseManagement.autoRun !== false, "新消息进入后自动生成 draft")}
      ${toggle("本人接收中间回复", "case-owner-intermediate-items", caseManagement.ownerIntermediateItems === true, "仅 owner 任务发送 Codex 的自然语言中间 item")}
      <div class="form-grid three">
        ${field("Worker 并发", "case-worker-concurrency", caseManagement.workerConcurrency || 2, { type: "number" })}
        ${field("群上下文注入条数", "case-group-context-limit", caseManagement.groupContextLimit ?? 50, { type: "number" })}
        ${field("群上下文保留（小时）", "case-group-context-retention", caseManagement.groupContextRetentionHours ?? 168, { type: "number" })}
        ${field("每群最多留存", "case-group-context-max", caseManagement.groupContextMaxMessages ?? 2000, { type: "number" })}
      </div>
    </div>`;
}

function knowledgeSettingsMarkup() {
  const kb = settings.knowledgeBase;
  const kbStatus = status.knowledgeBase || {};
  const summary = kbStatus.ready
    ? `${Number(kbStatus.noteCount || 0)} 篇文档 · ${time(kbStatus.lastSyncAt)}`
    : kbStatus.lastError || "尚未同步";
  return `
    <details class="settings-card settings-fold" data-settings-fold="knowledge" ${settingsFoldOpen.has("knowledge") ? "open" : ""}>
      <summary><span><strong>知识库</strong><small>${escapeHtml(summary)}</small></span></summary>
      <div class="settings-card-body">
        <div class="section-head"><div><h2>KB 路径与同步</h2><p>配置 Markdown 来源、检索范围与自动同步</p></div><button class="button secondary" data-action="sync-kb"><i data-lucide="cloud"></i><span>立即同步</span></button></div>
        ${toggle("启用知识库", "kb-enabled", kb.enabled, "检索相关 Markdown 并注入助手上下文")}
        <div class="form-grid three">
          ${field("Git Remote", "kb-remote", kb.remote, { full: true })}
          ${field("分支", "kb-branch", kb.branch)}
          ${field("本地目录", "kb-local-dir", kb.localDir)}
          ${field("同步间隔（秒）", "kb-interval", kb.syncIntervalSeconds, { type: "number" })}
          ${field("最多命中文档", "kb-max-notes", kb.maxNotes, { type: "number" })}
          ${field("单篇字符上限", "kb-max-chars", kb.maxCharsPerNote, { type: "number" })}
        </div>
        ${toggle("仅使用 approved 文档", "kb-approved", kb.requireApproved, "Frontmatter 需要 approved: true")}
      </div>
    </details>`;
}

function renderKnowledge() {
  content.innerHTML = `
    <div class="knowledge-page">
      <div class="knowledge-studio">
        <aside class="knowledge-list">
          <div class="knowledge-list-head">
            <span><strong>Markdown</strong><small>${knowledgeDocuments.length}</small></span>
            <button class="button secondary icon-only" data-action="new-kb" title="新建文档"><i data-lucide="plus"></i></button>
          </div>
          ${knowledgeDocuments.map((document) => `
            <button class="knowledge-item ${selectedKnowledge?.file === document.file ? "active" : ""}" data-kb-file="${escapeHtml(document.file)}">
              <i data-lucide="file-text"></i>
              <span><strong>${escapeHtml(document.title)}</strong><small>${escapeHtml(document.file)}</small></span>
              <em class="${document.approved ? "approved" : ""}">${document.approved ? document.audience : "draft"}</em>
            </button>
          `).join("") || `<div class="empty compact"><div>尚无知识文档</div></div>`}
        </aside>
        <div class="knowledge-editor-shell">
          ${selectedKnowledge ? `
            <div class="knowledge-toolbar">
              <input id="knowledge-file" class="input" value="${escapeHtml(selectedKnowledge.file)}" ${selectedKnowledge.hash ? "readonly" : ""} aria-label="知识文档路径">
              <div class="segmented compact">
                <button data-action="knowledge-mode" data-mode="source" class="${knowledgeMode === "source" ? "active" : ""}"><i data-lucide="file-text"></i><span>原文</span></button>
                <button data-action="knowledge-mode" data-mode="preview" class="${knowledgeMode === "preview" ? "active" : ""}"><i data-lucide="eye"></i><span>预览</span></button>
              </div>
              <button class="button danger icon-only" data-action="delete-kb" title="删除文档" ${selectedKnowledge.hash ? "" : "disabled"}><i data-lucide="trash-2"></i></button>
              <button class="button primary" data-action="save-kb" ${knowledgeDirty ? "" : "disabled"}><i data-lucide="save"></i><span>保存</span></button>
            </div>
            <textarea id="knowledge-editor" class="document-editor ${knowledgeMode === "source" ? "" : "hidden"}" spellcheck="false">${escapeHtml(selectedKnowledge.content || "")}</textarea>
            <article class="knowledge-preview ${knowledgeMode === "preview" ? "" : "hidden"}">${renderMarkdown(selectedKnowledge.content || "")}</article>
          ` : `<div class="empty"><div><i data-lucide="book-open"></i><div>选择或新建一篇 Markdown 文档</div></div></div>`}
        </div>
      </div>
    </div>`;
}

function renderSettings() {
  content.innerHTML = `
    <div class="settings-panel">
      ${accountsMarkup()}
      ${knowledgeSettingsMarkup()}
      ${assistantMarkup()}
    </div>`;
}

function renderRuntimeIdentity() {
  const build = document.querySelector("#runtime-build");
  if (!build || !status) return;
  const revision = String(status.runtime?.sourceRevision || "");
  build.textContent =
    `v${status.version || "unknown"}${revision ? ` · ${revision.slice(0, 8)}` : ""}`;
  build.title = revision
    ? `v${status.version}\n${revision}`
    : `v${status.version || "unknown"}`;
}

function renderHeaderControls() {
  if (!settings || !workers) return;
  const workerEnabled = !workers.paused;
  const workerToggle = document.querySelector("#worker-toggle");
  const workerControl = document.querySelector("#worker-control");
  workerToggle.checked = workerEnabled;
  workerControl.classList.toggle("worker-on", workerEnabled);
  workerControl.classList.toggle("worker-off", !workerEnabled);
  document.querySelector("#worker-label").textContent =
    workerEnabled ? "Workers ON" : "Workers OFF";

  const autoReplyEnabled = settings.caseManagement?.autoSend !== false;
  document.querySelector("#auto-reply-toggle").checked = autoReplyEnabled;
  document.querySelector("#auto-reply-label").textContent =
    autoReplyEnabled ? "Auto reply ON" : "Auto reply OFF";
}

function render() {
  const [eyebrow, title] = views[activeView];
  document.body.classList.toggle("view-cases", activeView === "cases");
  document.body.classList.toggle("view-knowledge", activeView === "knowledge");
  document.body.classList.toggle("view-settings", activeView === "settings");
  content.classList.toggle("case-content", activeView === "cases");
  content.classList.toggle("knowledge-content", activeView === "knowledge");
  document.querySelector("#view-eyebrow").textContent = eyebrow;
  document.querySelector("#view-title").textContent = title;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === activeView);
  });
  const configurable = activeView === "settings";
  document.querySelector("#save-button").classList.toggle("hidden", !configurable);
  saveState.classList.toggle("hidden", !configurable);
  if (!settings || !status) {
    content.innerHTML = `<div class="empty"><div><i data-lucide="refresh-cw"></i><div>正在读取运行状态</div></div></div>`;
  } else if (activeView === "cases") renderCases();
  else if (activeView === "knowledge") renderKnowledge();
  else if (activeView === "settings") renderSettings();
  renderRuntimeIdentity();
  renderHeaderControls();
  icons();
  if (activeView === "cases") initializeCaseResize();
  if (activeView === "cases" && selectedCase) {
    restoreCaseViewState(selectedCase.case_id);
  }
}

function readAccountForm() {
  const source = settings.pad.sources[selectedSource];
  if (!source || !document.querySelector("#source-id")) return;
  Object.assign(source, {
    displayName: document.querySelector("#source-name").value.trim(),
    id: document.querySelector("#source-id").value.trim(),
    selfId: document.querySelector("#source-wxid").value.trim(),
    apiUrl: document.querySelector("#source-api").value.trim(),
    wsUrl: document.querySelector("#source-ws")?.value.trim() ?? source.wsUrl,
    accessToken: document.querySelector("#source-token").value,
    accessTokenFile: document.querySelector("#source-token-file").value.trim(),
    enabled: document.querySelector("#source-enabled").checked,
    allowedSenderIds: parseList(document.querySelector("#source-senders").value),
    privateNicknameAllowlist: parseList(document.querySelector("#source-nicknames").value),
    allowedChatIds: parseList(document.querySelector("#source-groups").value),
    triggerKeywords: parseList(document.querySelector("#source-triggers").value),
    botNames: parseList(document.querySelector("#source-bot-names").value),
    selfChatPeers: parseList(document.querySelector("#source-peers").value),
    allowSelf: document.querySelector("#source-allow-self").checked,
    acceptSelfChatPeerMessages: document.querySelector("#source-accept-peers").checked,
  });
}

function readAssistantForm() {
  if (!document.querySelector("#assistant-mode")) return;
  Object.assign(settings.assistant, {
    mode: document.querySelector("#assistant-mode").value,
    historyTurns: Number(document.querySelector("#assistant-history").value),
    timeoutMs: Number(document.querySelector("#assistant-timeout").value),
    llmBaseUrl: document.querySelector("#assistant-base-url").value.trim(),
    llmModel: document.querySelector("#assistant-model").value.trim(),
    llmApiKey: document.querySelector("#assistant-api-key").value,
    webhookUrl: document.querySelector("#assistant-webhook-url").value.trim(),
    webhookToken: document.querySelector("#assistant-webhook-token").value,
    systemPrompt: document.querySelector("#assistant-prompt").value,
    codexBin: document.querySelector("#assistant-codex-bin").value.trim(),
    codexHome: document.querySelector("#assistant-codex-home").value.trim(),
    workingDirectory: document.querySelector("#assistant-working-directory").value.trim(),
    codexModel: document.querySelector("#assistant-codex-model").value.trim(),
    reasoningEffort: document.querySelector("#assistant-reasoning-effort").value.trim(),
    serviceTier: document.querySelector("#assistant-service-tier").value.trim(),
  });
  settings.caseManagement = {
    ...settings.caseManagement,
    autoRun: document.querySelector("#case-auto-run").checked,
    ownerIntermediateItems: document.querySelector(
      "#case-owner-intermediate-items",
    ).checked,
    groupContextLimit: Number(
      document.querySelector("#case-group-context-limit").value,
    ),
    groupContextRetentionHours: Number(
      document.querySelector("#case-group-context-retention").value,
    ),
    groupContextMaxMessages: Number(
      document.querySelector("#case-group-context-max").value,
    ),
    workerConcurrency: Number(
      document.querySelector("#case-worker-concurrency").value,
    ),
  };
}

function readKnowledgeForm() {
  if (!document.querySelector("#kb-enabled")) return;
  Object.assign(settings.knowledgeBase, {
    enabled: document.querySelector("#kb-enabled").checked,
    remote: document.querySelector("#kb-remote").value.trim(),
    branch: document.querySelector("#kb-branch").value.trim(),
    localDir: document.querySelector("#kb-local-dir").value.trim(),
    syncIntervalSeconds: Number(document.querySelector("#kb-interval").value),
    maxNotes: Number(document.querySelector("#kb-max-notes").value),
    maxCharsPerNote: Number(document.querySelector("#kb-max-chars").value),
    requireApproved: document.querySelector("#kb-approved").checked,
  });
}

function readCurrentForm() {
  if (activeView === "settings") {
    readAccountForm();
    readKnowledgeForm();
    readAssistantForm();
  }
}

async function load() {
  const [settingsBody, statusBody, casesBody, agentBody, knowledgeBody] = await Promise.all([
    api("/api/admin/settings"),
    api("/api/admin/status"),
    api(`/api/admin/cases?limit=${casePageSize}&offset=${casePage * casePageSize}`),
    api("/api/admin/agent"),
    api("/api/admin/kb/documents"),
  ]);
  settings = settingsBody.settings;
  status = statusBody;
  cases = casesBody.cases || [];
  caseTotal = Number(casesBody.total || cases.length);
  caseHasMore = Boolean(casesBody.hasMore);
  workers = casesBody.workers || {};
  agentDocument = agentBody.document;
  agentDirty = false;
  knowledgeDocuments = knowledgeBody.documents || [];
  if (selectedKnowledge?.file) {
    const match = knowledgeDocuments.find(
      (document) => document.file === selectedKnowledge.file,
    );
    selectedKnowledge = match
      ? (
          await api(
            `/api/admin/kb/document?file=${encodeURIComponent(match.file)}`,
          )
        ).document
      : null;
  } else if (knowledgeDocuments[0]) {
    selectedKnowledge = (
      await api(
        `/api/admin/kb/document?file=${encodeURIComponent(knowledgeDocuments[0].file)}`,
      )
    ).document;
  }
  knowledgeDirty = false;
  if (
    selectedCase &&
    !cases.some((item) => item.case_id === caseRootId(selectedCase))
  ) {
    selectedCase = null;
  }
  settings.pad ||= { sources: [] };
  settings.pad.sources ||= [];
  document.querySelector("#service-dot").classList.add("ok");
  document.querySelector("#service-label").textContent = "服务运行中";
  dirty = false;
  saveState.textContent = "";
  if (!caseListResizing) render();
}

document.addEventListener("input", (event) => {
  if (event.target.id === "agent-editor") {
    agentDirty = true;
    document.querySelector('[data-action="save-agent"]')?.removeAttribute("disabled");
    return;
  }
  if (event.target.id === "knowledge-editor") {
    knowledgeDirty = true;
    selectedKnowledge.content = event.target.value;
    document.querySelector('[data-action="save-kb"]')?.removeAttribute("disabled");
    return;
  }
  if (event.target.id === "knowledge-file") {
    knowledgeDirty = true;
    selectedKnowledge.file = event.target.value;
    document.querySelector('[data-action="save-kb"]')?.removeAttribute("disabled");
    return;
  }
  if (!event.target.matches("[data-dirty]")) return;
  dirty = true;
  saveState.textContent = "未保存";
  if (event.target.id === "source-ws-port") {
    const source = settings.pad.sources[selectedSource];
    const port = event.target.value.trim();
    const wxid = document.querySelector("#source-wxid").value.trim();
    document.querySelector("#source-ws").value =
      port && wxid ? `ws://127.0.0.1:${port}/ws/${wxid}` : "";
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-case-session]")) {
    const rootCaseId = event.target.dataset.caseSession;
    const targetCaseId = event.target.value;
    caseSessionSelections.set(rootCaseId, targetCaseId);
    try {
      await loadCase(targetCaseId);
    } catch (error) {
      showNotice(error.message, true);
    }
    return;
  }
  if (event.target.matches("[data-dirty]")) {
    dirty = true;
    saveState.textContent = "未保存";
  }
});

document.addEventListener("toggle", (event) => {
  const key = event.target.dataset?.settingsFold;
  if (!key) return;
  if (event.target.open) settingsFoldOpen.add(key);
  else settingsFoldOpen.delete(key);
}, true);

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-view]");
  if (nav) {
    if (
      activeView === "knowledge" &&
      nav.dataset.view !== "knowledge" &&
      knowledgeDirty &&
      !confirm("当前知识文档尚未保存，仍要离开吗？")
    ) return;
    readCurrentForm();
    activeView = nav.dataset.view;
    history.replaceState(null, "", `#${activeView}`);
    render();
    return;
  }
  const sourceButton = event.target.closest("[data-source-index]");
  if (sourceButton) {
    readAccountForm();
    selectedSource = Number(sourceButton.dataset.sourceIndex);
    render();
    return;
  }
  const caseButton = event.target.closest("[data-case-select]");
  if (caseButton) {
    await loadCase(caseButton.dataset.caseSelect);
    return;
  }
  const knowledgeButton = event.target.closest("[data-kb-file]");
  if (knowledgeButton) {
    if (knowledgeDirty && !confirm("当前知识文档尚未保存，仍要切换吗？")) return;
    selectedKnowledge = (
      await api(
        `/api/admin/kb/document?file=${encodeURIComponent(knowledgeButton.dataset.kbFile)}`,
      )
    ).document;
    knowledgeDirty = false;
    render();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  try {
    if (action === "add-source") {
      readAccountForm();
      settings.pad.sources.push({
        id: `account-${settings.pad.sources.length + 1}`,
        displayName: `微信账号 ${settings.pad.sources.length + 1}`,
        selfId: "",
        enabled: true,
        wsUrl: "",
        apiUrl: "http://127.0.0.1:18102/api",
        accessToken: "",
        accessTokenFile: "",
        allowSelf: false,
        selfChatPeers: [],
        acceptSelfChatPeerMessages: false,
        allowedChatIds: [],
        allowedSenderIds: [],
        privateNicknameAllowlist: [],
        triggerKeywords: ["webot"],
        botNames: ["Webot"],
      });
      selectedSource = settings.pad.sources.length - 1;
      dirty = true;
      saveState.textContent = "未保存";
      render();
    } else if (action === "delete-source") {
      settings.pad.sources.splice(selectedSource, 1);
      selectedSource = Math.max(0, selectedSource - 1);
      dirty = true;
      saveState.textContent = "未保存";
      render();
    } else if (action === "test-source") {
      readAccountForm();
      if (dirty) throw new Error("请先保存配置");
      const result = await api("/api/admin/opt/test", {
        method: "POST",
        body: JSON.stringify({ sourceId: settings.pad.sources[selectedSource].id }),
      });
      showNotice(result.source.ready ? "连接检测通过" : `连接未就绪：${result.source.lastError || result.source.state}`);
      await load();
    } else if (action === "sync-kb") {
      readKnowledgeForm();
      if (dirty) throw new Error("请先保存配置");
      if (knowledgeDirty) throw new Error("请先保存当前知识文档");
      const result = await api("/api/admin/kb/sync", { method: "POST" });
      showNotice(result.knowledgeBase.ready ? "知识库同步完成" : `同步失败：${result.knowledgeBase.lastError}`);
      await load();
    } else if (action === "save-agent") {
      agentDocument = (
        await api("/api/admin/agent", {
          method: "PUT",
          body: JSON.stringify({
            content: document.querySelector("#agent-editor").value,
            baseHash: agentDocument.hash,
          }),
        })
      ).document;
      agentDirty = false;
      showNotice("AGENTS.md 已保存，下一个 worker 会读取新策略");
      render();
    } else if (action === "new-kb") {
      if (knowledgeDirty && !confirm("当前知识文档尚未保存，仍要新建吗？")) return;
      const date = new Date().toISOString().slice(0, 10);
      selectedKnowledge = {
        file: "owner/new-note.md",
        content: `---\napproved: true\naudience: owner\nupdated: ${date}\n---\n# 新知识\n\n`,
        hash: "",
      };
      knowledgeDirty = true;
      knowledgeMode = "source";
      render();
      document.querySelector("#knowledge-file")?.focus();
    } else if (action === "knowledge-mode") {
      if (selectedKnowledge && document.querySelector("#knowledge-editor")) {
        selectedKnowledge.content = document.querySelector("#knowledge-editor").value;
      }
      knowledgeMode = event.target.closest("[data-mode]").dataset.mode;
      render();
    } else if (action === "save-kb") {
      selectedKnowledge.content = document.querySelector("#knowledge-editor").value;
      selectedKnowledge.file = document.querySelector("#knowledge-file").value.trim();
      selectedKnowledge = (
        await api("/api/admin/kb/document", {
          method: "PUT",
          body: JSON.stringify({
            file: selectedKnowledge.file,
            content: selectedKnowledge.content,
            baseHash: selectedKnowledge.hash || "",
          }),
        })
      ).document;
      knowledgeDirty = false;
      knowledgeDocuments = (
        await api("/api/admin/kb/documents")
      ).documents;
      showNotice("知识文档已保存");
      render();
    } else if (action === "delete-kb") {
      if (!confirm(`删除 ${selectedKnowledge.file}？`)) return;
      await api("/api/admin/kb/document", {
        method: "DELETE",
        body: JSON.stringify({
          file: selectedKnowledge.file,
          baseHash: selectedKnowledge.hash,
        }),
      });
      selectedKnowledge = null;
      knowledgeDirty = false;
      knowledgeDocuments = (
        await api("/api/admin/kb/documents")
      ).documents;
      if (knowledgeDocuments[0]) {
        selectedKnowledge = (
          await api(
            `/api/admin/kb/document?file=${encodeURIComponent(knowledgeDocuments[0].file)}`,
          )
        ).document;
      }
      showNotice("知识文档已删除");
      render();
    } else if (action === "probe-all") {
      for (const source of settings.pad.sources) {
        await api("/api/admin/opt/test", {
          method: "POST",
          body: JSON.stringify({ sourceId: source.id }),
        });
      }
      await load();
    } else if (action === "run-case") {
      const target = event.target.closest("[data-case-id]");
      await api("/api/admin/case/run", {
        method: "POST",
        body: JSON.stringify({ caseId: target.dataset.caseId }),
      });
      await refreshCases(true);
    } else if (action === "stop-case") {
      const target = event.target.closest("[data-case-id]");
      await api("/api/admin/case/stop", {
        method: "POST",
        body: JSON.stringify({ caseId: target.dataset.caseId }),
      });
      await refreshCases(true);
    } else if (action === "reset-session") {
      const target = event.target.closest("[data-case-id]");
      if (!confirm("重置后下一次将创建新的 Codex Session，继续吗？")) return;
      await api("/api/admin/case/session/reset", {
        method: "POST",
        body: JSON.stringify({ caseId: target.dataset.caseId }),
      });
      await refreshCases(true);
    } else if (action === "send-draft") {
      const target = event.target.closest("[data-draft-id]");
      if (!confirm("发送这个 draft 到微信？")) return;
      await api("/api/admin/case/send", {
        method: "POST",
        body: JSON.stringify({
          caseId: target.dataset.caseId,
          draftId: Number(target.dataset.draftId),
        }),
      });
      await refreshCases(true);
    } else if (action === "case-history") {
      const target = event.target.closest("[data-case-id]");
      const expanded = target.dataset.expanded !== "1";
      caseHistoryExpanded.set(target.dataset.caseId, expanded);
      caseViewStates.delete(target.dataset.caseId);
      await loadCase(target.dataset.caseId, { preserveView: false });
    } else if (action === "case-prev" && casePage > 0) {
      captureCaseViewState();
      casePage -= 1;
      selectedCase = null;
      await refreshCases(false);
    } else if (action === "case-next" && caseHasMore) {
      captureCaseViewState();
      casePage += 1;
      selectedCase = null;
      await refreshCases(false);
    } else if (action === "workers-toggle") {
      readCurrentForm();
      await api("/api/admin/workers/pause", {
        method: "POST",
        body: JSON.stringify({ paused: !event.target.checked }),
      });
      await refreshCases(false);
      showNotice(event.target.checked ? "Workers 已开启" : "Workers 已暂停");
    } else if (action === "auto-reply-toggle") {
      if (dirty) {
        render();
        throw new Error("请先保存当前配置");
      }
      const enabled = event.target.checked;
      settings = (
        await api("/api/admin/settings", {
          method: "PUT",
          body: JSON.stringify({
            caseManagement: { autoSend: enabled },
          }),
        })
      ).settings;
      showNotice(enabled ? "Auto reply 已开启" : "Auto reply 已关闭");
      render();
    }
  } catch (error) {
    showNotice(error.message, true);
  }
});

async function loadCase(caseId, options = {}) {
  if (options.preserveView !== false) captureCaseViewState();
  const history = caseHistoryExpanded.get(caseId) ? "1" : "0";
  selectedCase = (
    await api(
      `/api/admin/case?caseId=${encodeURIComponent(caseId)}&history=${history}`,
    )
  ).case;
  render();
}

async function refreshCases(includeDetail = false) {
  if (includeDetail) captureCaseViewState();
  const body = await api(
    `/api/admin/cases?limit=${casePageSize}&offset=${casePage * casePageSize}`,
  );
  if (!body.cases?.length && casePage > 0 && Number(body.total || 0) > 0) {
    casePage = Math.max(0, Math.ceil(Number(body.total) / casePageSize) - 1);
    return refreshCases(includeDetail);
  }
  cases = body.cases || [];
  caseTotal = Number(body.total || cases.length);
  caseHasMore = Boolean(body.hasMore);
  workers = body.workers || {};
  if (includeDetail && selectedCase) {
    const history = caseHistoryExpanded.get(selectedCase.case_id) ? "1" : "0";
    selectedCase = (
      await api(
        `/api/admin/case?caseId=${encodeURIComponent(selectedCase.case_id)}&history=${history}`,
      )
    ).case;
  }
  if (!caseListResizing) render();
}

async function reloadForRuntimeRevisionChange() {
  const nextStatus = await api("/api/admin/status");
  const revision = String(nextStatus.runtime?.sourceRevision || "");
  status = nextStatus;
  renderRuntimeIdentity();
  if (!pageRuntimeRevision || !revision || revision === pageRuntimeRevision) return;
  if (dirty || knowledgeDirty || agentDirty) {
    if (runtimeUpdateNoticeRevision !== revision) {
      runtimeUpdateNoticeRevision = revision;
      showNotice("Webot 已加载新版本；请保存当前编辑后刷新页面", true);
    }
    return;
  }
  window.location.reload();
}

window.setInterval(() => {
  if (activeView === "cases" && !dirty && !caseListResizing) {
    refreshCases(Boolean(selectedCase)).catch(() => {});
  }
}, 3000);

window.setInterval(() => {
  reloadForRuntimeRevisionChange().catch(() => {});
}, 5000);

document.querySelector("#save-button").addEventListener("click", async () => {
  try {
    readCurrentForm();
    saveState.textContent = "保存中";
    const body = await api("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    settings = body.settings;
    dirty = false;
    saveState.textContent = "已保存";
    showNotice("配置已生效");
    status = await api("/api/admin/status");
    render();
  } catch (error) {
    saveState.textContent = "保存失败";
    showNotice(error.message, true);
  }
});

document.querySelector("#refresh-button").addEventListener("click", () => {
  readCurrentForm();
  if (dirty || knowledgeDirty || agentDirty) {
    showNotice("存在未保存内容", true);
    return;
  }
  load().catch((error) => showNotice(error.message, true));
});

load().catch((error) => {
  document.querySelector("#service-label").textContent = "服务不可用";
  showNotice(error.message, true);
  render();
});
