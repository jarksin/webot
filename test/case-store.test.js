import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseManager } from "../src/case-manager.js";
import { CaseStore } from "../src/case-store.js";
import { SessionStore } from "../src/session-store.js";

function message(id = "message-1") {
  return {
    transport: "pad",
    sourceId: "small",
    sourceName: "小号",
    messageId: id,
    timestamp: Date.now(),
    chatType: "private",
    chatId: "owner_wxid",
    conversationId: "self-pair:owner_wxid--wxid_small",
    senderId: "owner_wxid",
    senderName: "Owner",
    selfId: "wxid_small",
    replyTarget: "owner_wxid",
    direction: "incoming",
    selfConversation: true,
    selfPeer: true,
    text: "ping",
    mentions: [],
  };
}

function groupMessage(id, text, timestamp = Date.now()) {
  return {
    transport: "pad",
    sourceId: "small",
    sourceName: "小号",
    messageId: id,
    timestamp,
    chatType: "group",
    chatId: "room@chatroom",
    conversationId: "group:small:room@chatroom",
    senderId: "group-member",
    senderName: "群成员",
    selfId: "wxid_small",
    replyTarget: "room@chatroom",
    direction: "incoming",
    text,
    mentions: [],
  };
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

test("persists a WeChat case, worker session, draft, and send result", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-case-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  const config = {
    assistant: { mode: "echo", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ codexSessionId }) {
        assert.equal(codexSessionId, "");
        return {
          text: "pong",
          sessionId: "codex-session-1",
          model: "test-model",
          effort: "high",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 10,
            outputTokens: 12,
            reasoningOutputTokens: 3,
          },
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(target, text) {
          sent.push({ target, text });
          return { ok: true, dryRun: true };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const received = await manager.receive(message());
  assert.equal(received.accepted, true);
  assert.equal(caseStore.listCases().length, 1);

  manager.enqueue(received.caseId, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const detail = caseStore.detail(received.caseId);
  assert.equal(detail.status, "draft_ready");
  assert.equal(detail.workerSession.status, "draft_ready");
  assert.equal(detail.workerSession.codex_session_id, "codex-session-1");
  assert.equal(detail.workerSession.model, "test-model");
  assert.equal(detail.workerSession.reasoning_effort, "high");
  assert.equal(detail.workerSession.request_count, 1);
  assert.equal(detail.workerSession.input_tokens, 100);
  assert.equal(detail.workerSession.output_tokens, 12);
  assert.equal(detail.workerSession.total_tokens, 112);
  assert.equal(detail.workerSession.estimated_cost_usd, null);
  assert.equal(detail.drafts[0].text, "pong");

  await manager.sendDraft(received.caseId, detail.drafts[0].id);
  assert.equal(sent.length, 1);
  assert.equal(caseStore.detail(received.caseId).status, "replied");
  assert.equal(caseStore.resetCodexSession(received.caseId), true);
  assert.equal(
    caseStore.detail(received.caseId).workerSession.codex_session_id,
    "",
  );
  caseStore.close();
});

test("reconciles inflated worker totals from the Codex session record", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-reconcile-"));
  const codexHome = path.join(directory, "codex");
  const sessionId = "reconcile-session";
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "09", "15");
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(sessionDirectory, `rollout-${sessionId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-09-15T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 800,
            cache_write_input_tokens: 100,
            output_tokens: 50,
            reasoning_output_tokens: 20,
          },
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 800,
            cache_write_input_tokens: 100,
            output_tokens: 50,
            reasoning_output_tokens: 20,
          },
        },
      },
    })}\n`,
  );
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const received = caseStore.ingest(message("reconcile-message"));
  caseStore.startRun(received.caseId, received.messageRow);
  caseStore.db.prepare(`
    UPDATE worker_sessions SET
      codex_session_id=?,
      model='company-gpt-5.6-sol',
      request_count=9,
      input_tokens=9000,
      output_tokens=900
    WHERE case_id=?
  `).run(sessionId, received.caseId);
  caseStore.setRuntimeSetting(`assistant_effort:${received.caseId}`, "high");

  assert.deepEqual(
    caseStore.reconcileCodexUsage({
      codexHome,
      model: "company-gpt-5.6-sol",
      reasoningEffort: "medium",
    }),
    { updated: 1 },
  );
  const session = caseStore.detail(received.caseId).workerSession;
  assert.equal(session.request_count, 1);
  assert.equal(session.input_tokens, 1_000);
  assert.equal(session.cached_input_tokens, 800);
  assert.equal(session.output_tokens, 50);
  assert.equal(session.total_tokens, 1_050);
  assert.equal(session.reasoning_effort, "high");
  assert.equal(session.estimated_cost_usd, 0.0029);
  assert.deepEqual(
    caseStore.reconcileCodexUsage({ codexHome }),
    { updated: 0 },
  );
  caseStore.close();
});

test("indexes observed and synced identities for bounded lookup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-directory-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  caseStore.observeIdentity({
    ...groupMessage("directory-group", "hello"),
    chatId: "project@chatroom",
    chatName: "项目讨论群",
    senderId: "wxid_member",
    senderName: "群成员甲",
  });
  caseStore.importDirectory([
    {
      sourceId: "small",
      entityType: "user",
      entityId: "wxid_friend",
      displayName: "好友备注",
      searchNames: ["好友备注", "好友昵称"],
      origin: "contacts",
    },
    {
      sourceId: "small",
      entityType: "official",
      entityId: "service-account",
      displayName: "服务号备注",
      searchNames: ["服务号备注"],
      origin: "contacts",
    },
  ]);
  caseStore.observeIdentity({
    transport: "pad",
    sourceId: "small",
    timestamp: Date.now(),
    chatType: "private",
    chatId: "service-account",
    senderId: "service-account",
    senderName: "临时名称",
  });
  caseStore.observeIdentity({
    transport: "pad",
    sourceId: "small",
    timestamp: Date.now(),
    chatType: "private",
    chatId: "gh_service",
    senderId: "gh_service",
    senderName: "不应入目录",
  });

  assert.deepEqual(
    caseStore.directory({ sourceId: "small", query: "项目" })
      .map((entry) => entry.entity_id),
    ["project@chatroom"],
  );
  assert.deepEqual(
    caseStore.directory({ sourceId: "small", query: "好友昵称" })
      .map((entry) => entry.entity_id),
    ["wxid_friend"],
  );
  assert.equal(
    caseStore.directory({ sourceId: "small", entityType: "user" }).length,
    2,
  );
  assert.deepEqual(
    caseStore.directory({ sourceId: "small", query: "服务号备注" })
      .map((entry) => [entry.entity_type, entry.display_name]),
    [["official", "服务号备注"]],
  );
  assert.equal(
    caseStore.directory({ sourceId: "small", query: "gh_service" }).length,
    0,
  );
  const indexes = caseStore.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((row) => row.name);
  assert.ok(indexes.includes("identity_directory_name"));
  assert.ok(indexes.includes("identity_directory_id"));
  caseStore.close();
});

test("uses directory names for private and group case titles", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-titles-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const group = caseStore.ingest({
    ...groupMessage("unnamed-group", "hello"),
    chatId: "unnamed@chatroom",
    conversationId: "group:small:unnamed@chatroom",
    senderName: "群成员甲",
  });
  const privateCase = caseStore.ingest({
    ...message("private-contact"),
    conversationId: "private:small:wxid_friend",
    chatId: "wxid_friend",
    senderId: "wxid_friend",
    senderName: "临时昵称",
    selfConversation: false,
    selfPeer: false,
  });

  assert.equal(caseStore.caseRow(group.caseId).title, "unnamed@chatroom");
  assert.equal(caseStore.caseRow(privateCase.caseId).title, "临时昵称");

  caseStore.importDirectory([
    {
      sourceId: "small",
      entityType: "group",
      entityId: "unnamed@chatroom",
      displayName: "项目讨论群",
      searchNames: ["项目讨论群"],
      origin: "contacts",
    },
    {
      sourceId: "small",
      entityType: "user",
      entityId: "wxid_friend",
      displayName: "好友备注",
      searchNames: ["好友备注", "好友昵称"],
      origin: "contacts",
    },
  ]);

  assert.equal(caseStore.caseRow(group.caseId).title, "项目讨论群");
  assert.equal(caseStore.caseRow(privateCase.caseId).title, "好友备注");
  caseStore.close();
});

test("stores allowed untriggered group messages and injects indexed context", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-context-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const contexts = [];
  const config = {
    assistant: { mode: "echo", llmModel: "" },
    caseManagement: {
      autoRun: true,
      autoSend: false,
      workerConcurrency: 1,
      groupContextLimit: 50,
      groupContextRetentionHours: 168,
      groupContextMaxMessages: 2000,
    },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(),
        acceptSelfChatPeerMessages: false,
        allowedChatIds: new Set(["room@chatroom"]),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ message: current, conversationContext }) {
        contexts.push({ current, conversationContext });
        return "done";
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const firstAt = Date.now() - 2000;
  const retained = await manager.receive(
    groupMessage("context-1", "前面的讨论", firstAt),
  );
  assert.equal(retained.accepted, false);
  assert.equal(retained.contextStored, true);
  assert.equal(caseStore.listCases().length, 0);

  const duplicate = await manager.receive(
    groupMessage("context-1", "前面的讨论", firstAt),
  );
  assert.equal(duplicate.contextStored, false);

  const triggered = await manager.receive(
    groupMessage("trigger-1", "webot 总结一下", firstAt),
  );
  assert.equal(triggered.accepted, true);
  await waitFor(() => manager.status().active === 0 && contexts.length === 1);
  assert.equal(contexts[0].current.text, "总结一下");
  assert.deepEqual(
    contexts[0].conversationContext.map((item) => item.text),
    ["前面的讨论"],
  );

  const plan = caseStore.db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM group_context_messages
    WHERE source_id=? AND conversation_id=?
      AND (timestamp, id)>(?, ?)
      AND (timestamp, id)<(?, ?)
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(
    "small",
    "group:small:room@chatroom",
    firstAt - 1,
    0,
    firstAt + 1,
    Number.MAX_SAFE_INTEGER,
    50,
  );
  assert.match(
    plan.map((item) => item.detail).join("\n"),
    /group_context_conversation_time/,
  );
  caseStore.close();
});

test("paginates case summaries and bounds default case detail history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-window-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const first = caseStore.ingest(message("page-1"));
  caseStore.ingest({
    ...message("page-2"),
    conversationId: "self-pair:other--wxid_small",
    chatId: "other",
    senderId: "other",
    senderName: "Other",
  });
  for (let index = 0; index < 55; index += 1) {
    caseStore.ingest({
      ...message(`history-${index}`),
      text: `history ${index}`,
      timestamp: Date.now() + index,
    });
    caseStore.addProgress(first.caseId, 1, `progress ${index}`);
    caseStore.addDraft(first.caseId, `draft ${index}`);
  }

  const page = caseStore.casePage({ limit: 1, offset: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.cases.length, 1);
  assert.equal(page.hasMore, false);

  const compact = caseStore.detail(first.caseId);
  assert.equal(compact.messages.length, 40);
  assert.equal(compact.drafts.length, 8);
  assert.equal(compact.progress.length, 40);
  assert.equal(compact.displayWindow.messageTruncated, true);
  assert.equal(compact.displayWindow.draftTruncated, true);
  assert.equal(compact.displayWindow.progressTruncated, true);

  const expanded = caseStore.detail(first.caseId, { expanded: true });
  assert.equal(expanded.messages.length, 56);
  assert.equal(expanded.drafts.length, 55);
  assert.equal(expanded.progress.length, 55);
  assert.equal(expanded.displayWindow.expanded, true);
  caseStore.close();
});

test("persists and sends owner attachments with the draft", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-artifact-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const artifact = path.join(directory, "answer.mp4");
  await fs.writeFile(artifact, "video");
  const sent = [];
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        return {
          text: "视频发你了。",
          artifacts: [{ path: artifact, filename: "answer.mp4", kind: "file" }],
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(_target, text) {
          sent.push({ type: "text", text });
          return { ok: true, dryRun: true };
        },
        async sendArtifact(_target, value) {
          sent.push({ type: "artifact", value });
          return { ok: true, dryRun: true, filename: value.filename };
        },
      },
    },
    requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });

  const received = await manager.receive(message("artifact-message"));
  manager.enqueue(received.caseId, true);
  await waitFor(() => manager.status().active === 0);
  const draft = caseStore.detail(received.caseId).drafts[0];
  assert.deepEqual(draft.artifacts, [{
    path: artifact,
    filename: "answer.mp4",
    kind: "file",
  }]);

  await manager.sendDraft(received.caseId, draft.id);
  assert.deepEqual(sent, [
    {
      type: "artifact",
      value: { path: artifact, filename: "answer.mp4", kind: "file" },
    },
    { type: "text", text: "视频发你了。" },
  ]);
  assert.equal(caseStore.detail(received.caseId).drafts[0].outbound.artifacts.length, 1);
  caseStore.close();
});

test("does not send completion text before attachments succeed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-artifact-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const received = caseStore.ingest(message("artifact-failure"));
  const draftId = caseStore.addDraft(
    received.caseId,
    "文件发你了。",
    "test-model",
    {
      triggerMessageId: received.messageRow,
      inputCutoffMessageId: received.messageRow,
      artifacts: [{ path: path.join(directory, "missing.mp3") }],
    },
  );
  let textSent = false;
  const manager = new CaseManager({
    config: {
      assistant: { mode: "echo", llmModel: "" },
      caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    },
    provider: {},
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send() {
          textSent = true;
          return { ok: true };
        },
        async sendArtifact() {
          throw new Error("attachment failed");
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await assert.rejects(
    manager.sendDraft(received.caseId, draftId),
    /attachment failed/,
  );
  assert.equal(textSent, false);
  assert.equal(caseStore.draft(received.caseId, draftId).status, "draft");
  caseStore.close();
});

test("keeps an auto-send attachment failure as a retryable draft", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-artifact-auto-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const config = {
    assistant: { mode: "echo", llmModel: "" },
    caseManagement: { autoRun: true, autoSend: true, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  let textSent = false;
  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        return {
          text: "文件发你了。",
          artifacts: [{ path: path.join(directory, "too-large.tar.gz") }],
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send() {
          textSent = true;
          return { ok: true };
        },
        async sendArtifact() {
          throw new Error("attachment exceeds 64 MiB");
        },
      },
    },
    requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.receive(message("artifact-auto-failure"));
  await waitFor(() => manager.status().active === 0);
  const detail = caseStore.detail(
    "wechat:small:self-pair:owner_wxid--wxid_small",
  );
  assert.equal(textSent, false);
  assert.equal(detail.status, "draft_ready");
  assert.equal(detail.workerSession.status, "draft_ready");
  assert.match(detail.drafts[0].error, /64 MiB/);
  assert.match(detail.last_error, /64 MiB/);
  caseStore.close();
});

test("requests source activation after an owner reply is handled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-activation-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const activations = [];
  const manager = new CaseManager({
    config: {
      assistant: { mode: "codex", llmModel: "" },
      caseManagement: { autoRun: true, autoSend: true, workerConcurrency: 1 },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: false,
          selfChatPeers: new Set(["wxid_owner"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(),
          allowedSenderIds: new Set(),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    },
    provider: {
      async reply() {
        return { text: "done", sessionId: "session-1" };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send() {
          return { ok: true, dryRun: false };
        },
      },
    },
    requesterAccess: () => "owner",
    async afterOwnerRun(context) {
      activations.push(context);
      return {
        requested: true,
        version: "0.6.15",
        revision: "1".repeat(40),
      };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.receive(message("activation-message"));
  await waitFor(() => manager.status().active === 0);

  assert.equal(activations.length, 1);
  assert.equal(activations[0].sourceId, "small");
  assert.equal(caseStore.detail(activations[0].caseId).status, "replied");
  assert.ok(
    caseStore
      .detail(activations[0].caseId)
      .progress
      .some((item) => /受控激活请求/.test(item.message)),
  );
  caseStore.close();
});

test("reruns a case when another message arrives during an active worker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-rerun-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const replies = [];
  let releaseFirst;
  const firstReply = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const manager = new CaseManager({
    config: {
      assistant: { mode: "echo", llmModel: "" },
      caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: false,
          selfChatPeers: new Set(["owner_wxid"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(),
          allowedSenderIds: new Set(),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    },
    provider: {
      async reply({ message: current }) {
        replies.push(current.text);
        if (replies.length === 1) await firstReply;
        return `reply:${current.text}`;
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.receive(message("message-1"));
  await waitFor(() => replies.length === 1);
  await manager.receive({ ...message("message-2"), text: "second" });
  assert.equal(manager.status().queued, 1);
  releaseFirst();
  await waitFor(() => replies.length === 2);
  await waitFor(() => manager.status().active === 0);
  assert.deepEqual(replies, ["ping", "second"]);
  assert.equal(caseStore.detail("wechat:small:self-pair:owner_wxid--wxid_small").drafts.length, 2);
  caseStore.close();
});

test("drain mode stops starting new workers without persisting a pause", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-drain-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  let replies = 0;
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: { autoRun: true, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        replies += 1;
        return "unused";
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const draining = manager.beginDrain();
  assert.equal(draining.draining, true);
  assert.equal(draining.paused, false);
  await manager.receive(message("drain-message"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(replies, 0);
  assert.equal(manager.status().queued, 1);
  assert.equal(caseStore.detail("wechat:small:self-pair:owner_wxid--wxid_small").status, "new");
  caseStore.close();
});

test("combines all unprocessed messages into one new Codex turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-pending-turn-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const receivedTurns = [];
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ message: current, currentMessageCount }) {
        receivedTurns.push({ text: current.text, currentMessageCount });
        return { text: "done", sessionId: "session-1" };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const first = await manager.receive(message("message-1"));
  await manager.receive({ ...message("message-2"), text: "继续" });
  manager.enqueue(first.caseId, true);
  await waitFor(() => manager.status().active === 0);

  assert.deepEqual(receivedTurns, [{
    text: "ping\n继续",
    currentMessageCount: 2,
  }]);
  assert.equal(
    caseStore.detail(first.caseId).workerSession.last_processed_message_id,
    2,
  );
  caseStore.close();
});

test("sends a completed draft to its original trigger message", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-draft-target-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  let releaseFirst;
  const firstReply = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const config = {
    assistant: { mode: "codex", llmModel: "" },
    caseManagement: {
      autoRun: true,
      autoSend: true,
      ownerIntermediateItems: false,
      workerConcurrency: 1,
    },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  let calls = 0;
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ message: current }) {
        calls += 1;
        if (calls === 1) await firstReply;
        return `reply:${current.text}`;
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(target, text) {
          sent.push({ messageId: target.messageId, text });
          return { ok: true, dryRun: false };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.receive(message("message-1"));
  await waitFor(() => calls === 1);
  await manager.receive({ ...message("message-2"), text: "继续" });
  releaseFirst();
  await waitFor(() => manager.status().active === 0 && sent.length === 2);

  assert.deepEqual(sent, [
    { messageId: "message-1", text: "reply:ping" },
    { messageId: "message-2", text: "reply:继续" },
  ]);
  caseStore.close();
});

test("restores pending cases into the worker queue after startup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-pending-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  const config = {
    assistant: { mode: "echo", llmModel: "" },
    caseManagement: { autoRun: true, autoSend: true, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const ingestOnly = new CaseManager({
    config: {
      ...config,
      caseManagement: { ...config.caseManagement, autoRun: false },
    },
    provider: { async reply() { return "unused"; } },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const received = await ingestOnly.receive(message());
  assert.equal(caseStore.detail(received.caseId).status, "new");

  const manager = new CaseManager({
    config,
    provider: {
      async reply() {
        return {
          text: "restored reply",
          sessionId: "restored-session",
          model: "test-model",
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(target, text) {
          sent.push({ target, text });
          return { ok: true, dryRun: false, messageId: "outbound-1" };
        },
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(manager.resumePending(), { queued: 1 });
  await waitFor(() => manager.status().active === 0);
  const detail = caseStore.detail(received.caseId);
  assert.equal(detail.status, "replied");
  assert.equal(detail.workerSession.codex_session_id, "restored-session");
  assert.equal(detail.workerSession.request_count, 1);
  assert.equal(detail.drafts[0].status, "sent");
  assert.equal(sent.length, 1);
  caseStore.close();
});

test("reuses the persisted Codex session on the next case run", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-resume-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessions = [];
  const config = {
    assistant: { mode: "codex", codexModel: "test-model", llmModel: "" },
    caseManagement: { autoRun: false, autoSend: false, workerConcurrency: 1 },
    pad: {
      sources: [{
        id: "small",
        strictPolicy: true,
        allowSelf: false,
        selfChatPeers: new Set(["owner_wxid"]),
        acceptSelfChatPeerMessages: true,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        privateNicknameAllowlist: new Set(),
        triggerKeywords: new Set(["webot"]),
        botNames: new Set(["Webot"]),
      }],
    },
    policy: {
      blockedSenderIds: new Set(),
      allowSelf: false,
      allowedChatIds: new Set(),
      allowedSenderIds: new Set(),
      groupTriggers: new Set(["webot"]),
    },
    identity: { botNames: new Set(["Webot"]) },
  };
  const manager = new CaseManager({
    config,
    provider: {
      async reply({ codexSessionId }) {
        sessions.push(codexSessionId);
        return {
          text: `reply-${sessions.length}`,
          sessionId: codexSessionId || "session-persisted",
          model: "test-model",
        };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {},
    logger: { info() {}, warn() {}, error() {} },
  });

  const received = await manager.receive(message());
  manager.enqueue(received.caseId, true);
  await waitFor(() => manager.status().active === 0);
  manager.enqueue(received.caseId, true);
  await waitFor(() => manager.status().active === 0);

  assert.deepEqual(sessions, ["", "session-persisted"]);
  const detail = caseStore.detail(received.caseId);
  assert.equal(detail.workerSession.codex_session_id, "session-persisted");
  assert.equal(detail.workerSession.request_count, 2);
  caseStore.close();
});

test("sends intermediate items only to owner self conversations", async () => {
  async function runFor(access, incoming = message()) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), `webot-intermediate-${access}-`),
    );
    const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
    const sent = [];
    const config = {
      assistant: { mode: "codex", codexModel: "test-model", llmModel: "" },
      caseManagement: {
        autoRun: false,
        autoSend: false,
        ownerIntermediateItems: true,
        workerConcurrency: 1,
      },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: true,
          selfChatPeers: new Set(["owner_wxid"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(["room@chatroom"]),
          allowedSenderIds: new Set(["owner_wxid"]),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    };
    const manager = new CaseManager({
      config,
      provider: {
        async reply({ onItem }) {
          await onItem({
            type: "agent_message",
            text: "正在检查配置",
          });
          await onItem({
            type: "agent_message",
            text: "正在检查配置",
          });
          return { text: "检查完成", sessionId: "session-1" };
        },
      },
      sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
      caseStore,
      transports: {
        pad: {
          async send(target, text) {
            sent.push({ target, text });
            return { ok: true, dryRun: false };
          },
        },
      },
      requesterAccess: () => access,
      logger: { info() {}, warn() {}, error() {} },
    });
    const received = await manager.receive(incoming);
    manager.enqueue(received.caseId, true);
    await waitFor(() => manager.status().active === 0);
    const liveProgress = caseStore
      .detail(received.caseId)
      .progress
      .filter((item) => item.level === "live")
      .map((item) => item.message);
    caseStore.close();
    return { sent, liveProgress };
  }

  const owner = await runFor("owner");
  const ownerSelf = await runFor("owner", {
    ...message("self-message"),
    chatId: "wxid_small",
    conversationId: "self:wxid_small",
    senderId: "wxid_small",
    selfId: "wxid_small",
    replyTarget: "wxid_small",
    selfPeer: false,
    exactSelfChat: true,
  });
  const ownerGroup = await runFor(
    "owner",
    groupMessage("group-message", "webot 检查配置"),
  );
  const ownerOrdinaryPrivate = await runFor("owner", {
    ...message("ordinary-private"),
    conversationId: "private:small:owner_wxid",
    selfConversation: false,
    selfPeer: false,
    exactSelfChat: false,
  });
  const publicRequester = await runFor("public");
  assert.deepEqual(owner.sent.map((item) => item.text), ["正在检查配置"]);
  assert.deepEqual(
    ownerSelf.sent.map((item) => item.text),
    ["正在检查配置"],
  );
  assert.deepEqual(ownerGroup.sent, []);
  assert.deepEqual(ownerOrdinaryPrivate.sent, []);
  assert.deepEqual(publicRequester.sent, []);
  assert.deepEqual(owner.liveProgress, ["正在检查配置"]);
  assert.deepEqual(ownerSelf.liveProgress, ["正在检查配置"]);
  assert.deepEqual(ownerGroup.liveProgress, ["正在检查配置"]);
  assert.deepEqual(
    ownerOrdinaryPrivate.liveProgress,
    ["正在检查配置"],
  );
  assert.deepEqual(publicRequester.liveProgress, ["正在检查配置"]);
});

test("handles owner slash commands locally and sends exactly one reply", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-slash-"));
  const codexHome = path.join(directory, "codex");
  await fs.mkdir(codexHome);
  await fs.writeFile(
    path.join(codexHome, "models_cache.json"),
    JSON.stringify({ models: [{ slug: "gpt-test" }] }),
  );
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sent = [];
  let providerCalls = 0;
  const manager = new CaseManager({
    config: {
      assistant: {
        mode: "codex",
        codexHome,
        codexModel: "gpt-test",
        reasoningEffort: "high",
      },
      caseManagement: {
        autoRun: true,
        autoSend: true,
        ownerIntermediateItems: true,
        workerConcurrency: 1,
      },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: false,
          selfChatPeers: new Set(["owner_wxid"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(),
          allowedSenderIds: new Set(),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    },
    provider: {
      async reply() {
        providerCalls += 1;
        return { text: "unexpected" };
      },
    },
    sessionStore: new SessionStore(path.join(directory, "sessions"), 4),
    caseStore,
    transports: {
      pad: {
        async send(_target, text) {
          sent.push(text);
          return { ok: true, dryRun: false };
        },
      },
    },
    requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });

  const command = message("slash-models");
  command.text = "/models";
  const received = await manager.receive(command);
  assert.equal(received.command, "model");
  assert.equal(received.queued, false);
  assert.equal(providerCalls, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /当前模型：gpt-test/);
  assert.equal(caseStore.detail(received.caseId).drafts.length, 1);
  caseStore.close();
});

test("routes named sessions to independent worker and history state", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webot-named-"));
  const caseStore = new CaseStore(path.join(directory, "webot.sqlite"));
  const sessionStore = new SessionStore(path.join(directory, "sessions"), 4);
  const providerCases = [];
  const sent = [];
  const manager = new CaseManager({
    config: {
      assistant: { mode: "codex", codexModel: "gpt-test" },
      caseManagement: {
        autoRun: true,
        autoSend: true,
        ownerIntermediateItems: false,
        workerConcurrency: 1,
      },
      pad: {
        sources: [{
          id: "small",
          strictPolicy: true,
          allowSelf: false,
          selfChatPeers: new Set(["owner_wxid"]),
          acceptSelfChatPeerMessages: true,
          allowedChatIds: new Set(),
          allowedSenderIds: new Set(),
          privateNicknameAllowlist: new Set(),
          triggerKeywords: new Set(["webot"]),
          botNames: new Set(["Webot"]),
        }],
      },
      policy: {
        blockedSenderIds: new Set(),
        allowSelf: false,
        allowedChatIds: new Set(),
        allowedSenderIds: new Set(),
        groupTriggers: new Set(["webot"]),
      },
      identity: { botNames: new Set(["Webot"]) },
    },
    provider: {
      async reply({ caseId, history }) {
        providerCases.push({ caseId, history });
        return { text: `reply:${caseId}`, sessionId: `codex:${caseId}` };
      },
    },
    sessionStore,
    caseStore,
    transports: {
      pad: {
        async send(_target, text) {
          sent.push(text);
          return { ok: true, dryRun: false };
        },
      },
    },
    requesterAccess: () => "owner",
    logger: { info() {}, warn() {}, error() {} },
  });

  const create = message("named-create");
  create.text = "/session new project-a";
  const created = await manager.receive(create);
  assert.equal(created.command, "session");
  assert.equal(sent.length, 1);

  const projectTask = message("named-task");
  projectTask.text = "project task";
  const projectReceived = await manager.receive(projectTask);
  assert.notEqual(projectReceived.caseId, created.caseId);
  await waitFor(() => manager.status().active === 0);
  const casePage = caseStore.casePage();
  assert.equal(casePage.total, 1);
  assert.deepEqual(
    casePage.cases.map((item) => item.case_id),
    [created.caseId],
  );
  assert.deepEqual(
    casePage.cases[0].caseSessionOptions.map((item) => ({
      name: item.name,
      targetCaseId: item.targetCaseId,
      active: item.active,
      exists: item.exists,
    })),
    [
      {
        name: "project-a",
        targetCaseId: projectReceived.caseId,
        active: true,
        exists: true,
      },
      {
        name: "main",
        targetCaseId: created.caseId,
        active: false,
        exists: true,
      },
    ],
  );
  const projectDetail = caseStore.detail(projectReceived.caseId);
  assert.equal(projectDetail.title, "Owner");
  assert.equal(projectDetail.namedSession.name, "project-a");
  assert.equal(projectDetail.namedSession.scopeCaseId, created.caseId);
  assert.equal(projectDetail.caseSessionOptions.length, 2);
  assert.equal(providerCases[0].caseId, projectReceived.caseId);
  assert.deepEqual(
    providerCases[0].history.map(({ role, content }) => ({ role, content })),
    [{ role: "user", content: "project task" }],
  );

  const list = message("named-list");
  list.text = "/session list";
  const listed = await manager.receive(list);
  assert.equal(listed.caseId, projectReceived.caseId);
  assert.match(sent.at(-1), /\* project-a/);

  const main = message("named-main");
  main.text = "/session main";
  await manager.receive(main);
  const mainTask = message("named-main-task");
  mainTask.text = "main task";
  const mainReceived = await manager.receive(mainTask);
  assert.equal(mainReceived.caseId, created.caseId);
  await waitFor(() => manager.status().active === 0);
  assert.equal(providerCases[1].caseId, created.caseId);
  assert.deepEqual(
    providerCases[1].history.map(({ role, content }) => ({ role, content })),
    [{ role: "user", content: "main task" }],
  );
  assert.notEqual(
    caseStore.workerSession(created.caseId).codex_session_id,
    caseStore.workerSession(projectReceived.caseId).codex_session_id,
  );
  caseStore.close();
});
