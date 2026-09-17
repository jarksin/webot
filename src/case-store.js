import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  activeSession,
  activateSession,
  createSession,
  deleteSession,
  ensureSessionScope,
  installNamedSessionSchema,
  listSessions,
  sessionByName,
  sessionForTarget,
} from "./named-sessions.js";
import {
  estimateCodexCostUsd,
  normalizeCodexUsage,
  parseCodexSessionUsage,
} from "./codex-usage.js";
import { isDirectoryContactId } from "./contact-directory.js";

function json(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function now() {
  return Date.now();
}

function caseIdFor(message) {
  const conversation =
    message.conversationId ||
    `${message.chatType || "private"}:${message.chatId}`;
  const namespace = message.transport === "pad"
    ? "wechat"
    : String(message.transport || "message");
  return `${namespace}:${message.sourceId || "default"}:${conversation}`;
}

function conversationIdFor(message) {
  return String(
    message.conversationId ||
    `${message.chatType || "private"}:${message.chatId}`,
  );
}

function withoutMediaPayloads(value, key = "") {
  if (value == null) return value;
  if (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return undefined;
  }
  if (
    key &&
    /(?:base64|binary|blob|buffer|bytes|payload|local_?path|file_?path)$/i
      .test(key)
  ) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => withoutMediaPayloads(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [
          childKey,
          withoutMediaPayloads(childValue, childKey),
        ])
        .filter(([, childValue]) => childValue !== undefined),
    );
  }
  return value;
}

function syncedMessageSnapshot(message) {
  const { text: _text, attachments: _attachments, ...metadata } = message || {};
  return {
    attachments: withoutMediaPayloads(message?.attachments || []),
    metadata: withoutMediaPayloads(metadata),
  };
}

function syncedMessageRow(row) {
  return {
    ...row,
    accepted: row.accepted == null ? null : Boolean(row.accepted),
    attachments: json(row.attachments_json, []),
    mentions: json(row.mentions_json, []),
    metadata: json(row.metadata_json, {}),
  };
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export class CaseStore {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        case_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(source_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS messages_case_time
        ON messages(case_id, timestamp, id);
      CREATE TABLE IF NOT EXISTS group_context_messages (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(source_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS group_context_conversation_time
        ON group_context_messages(
          source_id, conversation_id, timestamp DESC, id DESC
        );
      CREATE INDEX IF NOT EXISTS group_context_expiry
        ON group_context_messages(timestamp);
      CREATE TABLE IF NOT EXISTS synced_messages (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        direction TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        mentions_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        decision TEXT NOT NULL DEFAULT 'received',
        accepted INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(source_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS synced_messages_conversation_time
        ON synced_messages(
          source_id, conversation_id, timestamp DESC, id DESC
        );
      CREATE INDEX IF NOT EXISTS synced_messages_chat_time
        ON synced_messages(source_id, chat_id, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS synced_messages_sender_time
        ON synced_messages(source_id, sender_id, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS synced_messages_expiry
        ON synced_messages(timestamp);
      CREATE TABLE IF NOT EXISTS identity_directory (
        source_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        search_names TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'message',
        message_count INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(source_id, entity_id)
      );
      CREATE INDEX IF NOT EXISTS identity_directory_name
        ON identity_directory(
          source_id, entity_type, display_name COLLATE NOCASE, entity_id
        );
      CREATE INDEX IF NOT EXISTS identity_directory_id
        ON identity_directory(source_id, entity_id COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS identity_directory_recent
        ON identity_directory(source_id, last_seen DESC);
      CREATE TABLE IF NOT EXISTS cases (
        case_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER,
        last_message_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cases_updated ON cases(updated_at DESC);
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY,
        case_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        outbound_json TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(case_id) REFERENCES cases(case_id)
      );
      CREATE INDEX IF NOT EXISTS drafts_case_time
        ON drafts(case_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS worker_sessions (
        case_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        run_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        finished_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(case_id) REFERENCES cases(case_id)
      );
      CREATE TABLE IF NOT EXISTS progress (
        id INTEGER PRIMARY KEY,
        case_id TEXT NOT NULL,
        run_count INTEGER NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(case_id) REFERENCES cases(case_id)
      );
      CREATE INDEX IF NOT EXISTS progress_case_time
        ON progress(case_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const migratedAt = now();
    this.db.exec(`
      INSERT OR IGNORE INTO synced_messages(
        source_id, conversation_id, message_id, timestamp, direction,
        sender_id, sender_name, chat_type, chat_id, chat_name, text,
        attachments_json, mentions_json, metadata_json, decision, accepted,
        created_at, updated_at
      )
      SELECT source_id,
        COALESCE(
          json_extract(message_json, '$.conversationId'),
          CASE
            WHEN chat_type='group'
              THEN 'group:' || source_id || ':' || chat_id
            ELSE chat_type || ':' || source_id || ':' || chat_id
          END
        ),
        message_id, timestamp, direction, sender_id, sender_name, chat_type,
        chat_id, COALESCE(json_extract(message_json, '$.chatName'), ''), text,
        COALESCE(json_extract(message_json, '$.attachments'), '[]'),
        COALESCE(json_extract(message_json, '$.mentions'), '[]'),
        '{}', 'accepted', 1, created_at, ${migratedAt}
      FROM messages;

      INSERT OR IGNORE INTO synced_messages(
        source_id, conversation_id, message_id, timestamp, direction,
        sender_id, sender_name, chat_type, chat_id, chat_name, text,
        attachments_json, mentions_json, metadata_json, decision, accepted,
        created_at, updated_at
      )
      SELECT source_id, conversation_id, message_id, timestamp, direction,
        sender_id, sender_name, 'group',
        COALESCE(json_extract(message_json, '$.chatId'), ''),
        COALESCE(json_extract(message_json, '$.chatName'), ''), text,
        COALESCE(json_extract(message_json, '$.attachments'), '[]'),
        COALESCE(json_extract(message_json, '$.mentions'), '[]'),
        '{}', 'context-stored', 0, created_at, ${migratedAt}
      FROM group_context_messages;
    `);
    installNamedSessionSchema(this.db);
    ensureColumn(
      this.db,
      "worker_sessions",
      "codex_session_id",
      "TEXT NOT NULL DEFAULT ''",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "model",
      "TEXT NOT NULL DEFAULT ''",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "request_count",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "cached_input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "cache_write_input_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "output_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "reasoning_output_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "reasoning_effort",
      "TEXT NOT NULL DEFAULT ''",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "estimated_cost_usd",
      "REAL",
    );
    const addedProcessedMessageCursor = ensureColumn(
      this.db,
      "worker_sessions",
      "last_processed_message_id",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "worker_sessions",
      "input_cutoff_message_id",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "drafts",
      "trigger_message_id",
      "INTEGER",
    );
    ensureColumn(
      this.db,
      "drafts",
      "input_cutoff_message_id",
      "INTEGER NOT NULL DEFAULT 0",
    );
    ensureColumn(
      this.db,
      "drafts",
      "artifacts_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    if (addedProcessedMessageCursor) {
      this.db.exec(`
        UPDATE worker_sessions
        SET last_processed_message_id=COALESCE(
          (SELECT last_message_id FROM cases
           WHERE cases.case_id=worker_sessions.case_id),
          0
        )
      `);
    }
    const recoveredAt = now();
    this.db.exec(`
      INSERT INTO progress(case_id, run_count, level, message, created_at)
      SELECT case_id, run_count, 'warn',
        'Webot 重启中断了 worker，Case 已恢复为待处理',
        ${recoveredAt}
      FROM worker_sessions
      WHERE status='running';
      UPDATE worker_sessions
      SET status='stopped', last_error='Webot restarted during worker run',
          finished_at=${recoveredAt}, updated_at=${recoveredAt}
      WHERE status='running';
      UPDATE cases
      SET status='new', last_error='', updated_at=${recoveredAt}
      WHERE status='running';
    `);
    this.groupContextWrites = 0;
    this.groupContextCounts = new Map();
    this.syncedMessageWrites = 0;
    this.syncedMessageCounts = new Map();
    this.refreshCaseTitles();
  }

  directoryDisplayName(sourceId, entityId) {
    const row = this.db.prepare(`
      SELECT display_name
      FROM identity_directory
      WHERE source_id=? AND entity_id=? AND display_name!=''
      LIMIT 1
    `).get(
      String(sourceId || "default"),
      String(entityId || ""),
    );
    return String(row?.display_name || "").trim();
  }

  caseBaseTitle(message) {
    const sourceId = String(message?.sourceId || "default");
    const chatId = String(message?.chatId || "").trim();
    const directoryName = this.directoryDisplayName(sourceId, chatId);
    if (directoryName) return directoryName;
    if (message?.chatType === "group") {
      return String(message.chatName || "").trim() || chatId || "微信群聊";
    }
    const peerName =
      String(message?.senderId || "") === chatId
        ? String(message?.senderName || "").trim()
        : "";
    return String(message?.chatName || "").trim()
      || peerName
      || chatId
      || String(message?.senderId || "").trim()
      || (message?.transport === "telegram" ? "Telegram 会话" : "微信会话");
  }

  refreshCaseTitles(sourceId = "") {
    const source = String(sourceId || "").trim();
    const where = source ? "AND c.source_id=?" : "";
    const rows = this.db.prepare(`
      SELECT c.case_id, c.title, d.display_name,
        s.session_id, s.name AS session_name
      FROM cases c
      JOIN identity_directory d
        ON d.source_id=c.source_id
       AND d.entity_id=c.chat_id
       AND d.display_name!=''
      LEFT JOIN assistant_sessions s
        ON s.target_case_id=c.case_id
       AND s.deleted_at=0
      WHERE 1=1 ${where}
    `).all(...(source ? [source] : []));
    const update = this.db.prepare(`
      UPDATE cases SET title=? WHERE case_id=? AND title!=?
    `);
    let updated = 0;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const baseTitle = String(row.display_name || "").trim();
        const title = row.session_id && row.session_id !== "main"
          ? `${baseTitle} / ${row.session_name}`
          : baseTitle;
        updated += update.run(title, row.case_id, title).changes;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return updated;
  }

  upsertIdentity(entry, options = {}) {
    const sourceId = String(entry.sourceId || "default").trim();
    const entityType = String(entry.entityType || "").trim();
    const entityId = String(entry.entityId || "").trim();
    if (!sourceId || !entityType || !entityId) return false;
    const timestamp = Number(entry.lastSeen || 0);
    const searchNames = [
      ...new Set(
        (entry.searchNames || [])
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    ].join("\n");
    this.db.prepare(`
      INSERT INTO identity_directory(
        source_id, entity_type, entity_id, display_name, search_names,
        origin, message_count, last_seen, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, entity_id) DO UPDATE SET
        entity_type=CASE
          WHEN excluded.origin='contacts' THEN excluded.entity_type
          WHEN identity_directory.origin='contacts'
            THEN identity_directory.entity_type
          ELSE excluded.entity_type
        END,
        display_name=CASE
          WHEN excluded.origin='contacts' AND excluded.display_name!=''
            THEN excluded.display_name
          WHEN identity_directory.origin='contacts'
            THEN identity_directory.display_name
          WHEN excluded.display_name!='' THEN excluded.display_name
          ELSE identity_directory.display_name
        END,
        search_names=CASE
          WHEN excluded.origin='contacts' AND excluded.search_names!=''
            THEN excluded.search_names
          WHEN identity_directory.origin='contacts'
            THEN identity_directory.search_names
          WHEN excluded.search_names!='' THEN excluded.search_names
          ELSE identity_directory.search_names
        END,
        origin=CASE
          WHEN excluded.origin='contacts' THEN excluded.origin
          ELSE identity_directory.origin
        END,
        message_count=identity_directory.message_count + excluded.message_count,
        last_seen=MAX(identity_directory.last_seen, excluded.last_seen),
        updated_at=excluded.updated_at
    `).run(
      sourceId,
      entityType,
      entityId,
      String(entry.displayName || "").trim(),
      searchNames,
      String(entry.origin || "message"),
      options.incrementMessage ? 1 : 0,
      timestamp,
      now(),
    );
    return true;
  }

  observeIdentity(message) {
    const sourceId = String(message?.sourceId || "default");
    const timestamp = Number(message?.timestamp || now());
    let changed = false;
    const validIdentityId = (value) =>
      message?.transport === "telegram"
        ? /^tg:-?\d+$/i.test(String(value || ""))
        : isDirectoryContactId(value);
    if (
      message?.chatType === "group" &&
      validIdentityId(message.chatId)
    ) {
      changed = this.upsertIdentity({
        sourceId,
        entityType: "group",
        entityId: message.chatId,
        displayName: message.chatName,
        searchNames: [message.chatName],
        lastSeen: timestamp,
      }, { incrementMessage: true }) || changed;
    }
    if (
      validIdentityId(message?.senderId) &&
      message.senderId !== message.chatId
    ) {
      changed = this.upsertIdentity({
        sourceId,
        entityType: "user",
        entityId: message.senderId,
        displayName: message.senderName,
        searchNames: [message.senderName],
        lastSeen: timestamp,
      }, { incrementMessage: true }) || changed;
    } else if (
      message?.chatType === "private" &&
      validIdentityId(message?.senderId)
    ) {
      changed = this.upsertIdentity({
        sourceId,
        entityType: "user",
        entityId: message.senderId,
        displayName: message.senderName,
        searchNames: [message.senderName],
        lastSeen: timestamp,
      }, { incrementMessage: true }) || changed;
    }
    if (changed) this.refreshCaseTitles(sourceId);
    return changed;
  }

  directoryIdentities(sourceId) {
    return this.db.prepare(`
      SELECT entity_id, entity_type
      FROM identity_directory
      WHERE source_id=?
    `).all(String(sourceId || ""));
  }

  removeDirectoryEntries(sourceId, entityIds) {
    const ids = [...new Set(
      (entityIds || []).map((id) => String(id || "").trim()).filter(Boolean),
    )];
    if (!ids.length) return 0;
    const statement = this.db.prepare(`
      DELETE FROM identity_directory
      WHERE source_id=? AND entity_id=?
    `);
    let removed = 0;
    this.db.exec("BEGIN");
    try {
      for (const id of ids) {
        removed += statement.run(String(sourceId || ""), id).changes;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  importDirectory(entries) {
    let imported = 0;
    this.db.exec("BEGIN");
    try {
      for (const entry of entries || []) {
        if (this.upsertIdentity(entry)) imported += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.refreshCaseTitles();
    return imported;
  }

  directory(options = {}) {
    const sourceId = String(options.sourceId || "").trim();
    const entityType = String(options.entityType || "").trim();
    const query = String(options.query || "").trim();
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    const clauses = [];
    const parameters = [];
    if (sourceId) {
      clauses.push("source_id=?");
      parameters.push(sourceId);
    }
    if (entityType) {
      clauses.push("entity_type=?");
      parameters.push(entityType);
    }
    if (query) {
      const escaped = query.replace(/[\\%_]/g, "\\$&");
      clauses.push(`(
        entity_id=? COLLATE NOCASE OR
        display_name=? COLLATE NOCASE OR
        entity_id LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        display_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR
        search_names LIKE ? ESCAPE '\\' COLLATE NOCASE
      )`);
      parameters.push(
        query,
        query,
        `${escaped}%`,
        `${escaped}%`,
        `%${escaped}%`,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT source_id, entity_type, entity_id, display_name, search_names,
        origin, message_count, last_seen, updated_at
      FROM identity_directory
      ${where}
      ORDER BY
        CASE WHEN entity_id=? COLLATE NOCASE THEN 0
             WHEN display_name=? COLLATE NOCASE THEN 1
             ELSE 2 END,
        last_seen DESC, display_name COLLATE NOCASE, entity_id
      LIMIT ?
    `).all(...parameters, query, query, limit).map((entry) => ({
      ...entry,
      searchNames: String(entry.search_names || "").split("\n").filter(Boolean),
    }));
  }

  close() {
    this.db.close();
  }

  runtimeSetting(key, fallback = "") {
    const row = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key=?")
      .get(String(key));
    return row ? String(row.value) : fallback;
  }

  setRuntimeSetting(key, value) {
    this.db.prepare(`
      INSERT INTO runtime_settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE
      SET value=excluded.value, updated_at=excluded.updated_at
    `).run(String(key), String(value), now());
  }

  deleteRuntimeSetting(key) {
    this.db.prepare("DELETE FROM runtime_settings WHERE key=?").run(String(key));
  }

  ensureSessionScope(scopeCaseId) {
    return ensureSessionScope(this.db, scopeCaseId);
  }

  activeSession(scopeCaseId) {
    return activeSession(this.db, scopeCaseId);
  }

  listSessions(scopeCaseId) {
    ensureSessionScope(this.db, scopeCaseId);
    return listSessions(this.db, scopeCaseId);
  }

  sessionByName(scopeCaseId, name) {
    ensureSessionScope(this.db, scopeCaseId);
    return sessionByName(this.db, scopeCaseId, name);
  }

  sessionForTarget(caseId) {
    return sessionForTarget(this.db, caseId);
  }

  createSession(scopeCaseId, name) {
    return createSession(this.db, scopeCaseId, name);
  }

  activateSession(scopeCaseId, name) {
    return activateSession(this.db, scopeCaseId, name);
  }

  deleteSession(scopeCaseId, name) {
    return deleteSession(this.db, scopeCaseId, name);
  }

  ingestSyncedMessage(message, options = {}) {
    if (!["pad", "telegram"].includes(message?.transport)) {
      return { inserted: false, reason: "not-gateway" };
    }
    const createdAt = now();
    const sourceId = String(message.sourceId || "default");
    const conversationId = conversationIdFor(message);
    const snapshot = syncedMessageSnapshot(message);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO synced_messages(
        source_id, conversation_id, message_id, timestamp, direction,
        sender_id, sender_name, chat_type, chat_id, chat_name, text,
        attachments_json, mentions_json, metadata_json, decision, accepted,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', NULL, ?, ?)
    `).run(
      sourceId,
      conversationId,
      String(message.messageId),
      Number(message.timestamp || createdAt),
      String(message.direction || "incoming"),
      String(message.senderId || ""),
      String(message.senderName || ""),
      String(message.chatType || "private"),
      String(message.chatId || ""),
      String(message.chatName || ""),
      String(message.text || ""),
      JSON.stringify(snapshot.attachments),
      JSON.stringify(message.mentions || []),
      JSON.stringify(snapshot.metadata),
      createdAt,
      createdAt,
    );
    const existing = result.changes
      ? null
      : this.db.prepare(`
          SELECT id FROM synced_messages
          WHERE source_id=? AND message_id=?
          LIMIT 1
        `).get(sourceId, String(message.messageId));
    const rowId = Number(result.lastInsertRowid || existing?.id || 0);
    if (!result.changes) {
      return {
        inserted: false,
        reason: "duplicate",
        rowId,
        conversationId,
      };
    }

    this.syncedMessageWrites += 1;
    const countKey = `${sourceId}\u0000${conversationId}`;
    let conversationCount = this.syncedMessageCounts.get(countKey);
    if (conversationCount == null) {
      conversationCount = Number(
        this.db.prepare(`
          SELECT COUNT(*) AS count FROM synced_messages
          WHERE source_id=? AND conversation_id=?
        `).get(sourceId, conversationId).count || 0,
      );
    } else {
      conversationCount += 1;
    }
    this.syncedMessageCounts.set(countKey, conversationCount);
    const maxMessages = Math.min(
      Math.max(Number(options.maxMessages) || 2000, 100),
      100_000,
    );
    const pruneExpired =
      this.syncedMessageWrites === 1 || this.syncedMessageWrites % 100 === 0;
    if (pruneExpired || conversationCount > maxMessages) {
      this.pruneSyncedMessages(sourceId, conversationId, {
        ...options,
        pruneExpired,
      });
      this.syncedMessageCounts.set(
        countKey,
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count FROM synced_messages
            WHERE source_id=? AND conversation_id=?
          `).get(sourceId, conversationId).count || 0,
        ),
      );
    }
    return { inserted: true, rowId, conversationId };
  }

  markSyncedMessageResult(message, result = {}) {
    if (message?.transport !== "pad") return false;
    const accepted = result.accepted === true ? 1 : 0;
    const decision = accepted
      ? "accepted"
      : String(result.reason || "rejected");
    const updated = this.db.prepare(`
      UPDATE synced_messages
      SET decision=CASE
            WHEN accepted=1 AND ?=0 THEN decision
            ELSE ?
          END,
          accepted=CASE
            WHEN accepted=1 THEN 1
            ELSE ?
          END,
          updated_at=?
      WHERE source_id=? AND message_id=?
    `).run(
      accepted,
      decision,
      accepted,
      now(),
      String(message.sourceId || "default"),
      String(message.messageId),
    );
    return Boolean(updated.changes);
  }

  pruneSyncedMessages(sourceId, conversationId, options = {}) {
    const retentionHours = Math.min(
      Math.max(Number(options.retentionHours) || 168, 1),
      24 * 365,
    );
    const maxMessages = Math.min(
      Math.max(Number(options.maxMessages) || 2000, 100),
      100_000,
    );
    if (options.pruneExpired !== false) {
      this.db.prepare(
        "DELETE FROM synced_messages WHERE timestamp<?",
      ).run(now() - retentionHours * 60 * 60 * 1000);
      this.syncedMessageCounts.clear();
    }
    this.db.prepare(`
      DELETE FROM synced_messages
      WHERE source_id=? AND conversation_id=? AND id IN (
        SELECT id FROM synced_messages
        WHERE source_id=? AND conversation_id=?
        ORDER BY timestamp DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(
      sourceId,
      conversationId,
      sourceId,
      conversationId,
      maxMessages,
    );
  }

  syncedMessages(options = {}) {
    const sourceId = String(options.sourceId || "").trim();
    const conversationId = String(options.conversationId || "").trim();
    const chatId = String(options.chatId || "").trim();
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
    const clauses = [];
    const parameters = [];
    if (sourceId) {
      clauses.push("source_id=?");
      parameters.push(sourceId);
    }
    if (conversationId) {
      clauses.push("conversation_id=?");
      parameters.push(conversationId);
    }
    if (chatId) {
      clauses.push("chat_id=?");
      parameters.push(chatId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM synced_messages
        ${where}
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `).all(...parameters, limit).map(syncedMessageRow);
  }

  syncedMessagePage(options = {}) {
    const sourceId = String(options.sourceId || "").trim();
    const chatType = String(options.chatType || "").trim();
    const result = String(options.result || "").trim();
    const query = String(options.query || "").trim().slice(0, 200);
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const clauses = [];
    const parameters = [];
    if (sourceId) {
      clauses.push("source_id=?");
      parameters.push(sourceId);
    }
    if (chatType) {
      clauses.push("chat_type=?");
      parameters.push(chatType);
    }
    if (result === "accepted") {
      clauses.push("accepted=1");
    } else if (result === "rejected") {
      clauses.push("accepted=0");
    } else if (result === "pending") {
      clauses.push("accepted IS NULL");
    }
    if (query) {
      const pattern = `%${query}%`;
      clauses.push(`(
        message_id LIKE ? OR sender_id LIKE ? OR sender_name LIKE ?
        OR chat_id LIKE ? OR chat_name LIKE ? OR text LIKE ?
        OR decision LIKE ?
      )`);
      parameters.push(
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = Number(
      this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM synced_messages
        ${where}
      `).get(...parameters).count || 0,
    );
    const messages = this.db.prepare(`
      SELECT * FROM synced_messages
      ${where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset).map(syncedMessageRow);
    return {
      messages,
      total,
      limit,
      offset,
      hasMore: offset + messages.length < total,
    };
  }

  ingestGroupContext(message, options = {}) {
    if (message?.chatType !== "group") {
      return { inserted: false, reason: "not-group" };
    }
    const createdAt = now();
    const sourceId = String(message.sourceId || "default");
    const conversationId = conversationIdFor(message);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO group_context_messages(
        source_id, conversation_id, message_id, timestamp, direction,
        sender_id, sender_name, text, message_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceId,
      conversationId,
      String(message.messageId),
      Number(message.timestamp || createdAt),
      String(message.direction || "incoming"),
      String(message.senderId || ""),
      String(message.senderName || ""),
      String(message.text || ""),
      JSON.stringify(message),
      createdAt,
    );
    if (!result.changes) return { inserted: false, reason: "duplicate" };

    this.groupContextWrites += 1;
    const countKey = `${sourceId}\u0000${conversationId}`;
    let conversationCount = this.groupContextCounts.get(countKey);
    if (conversationCount == null) {
      conversationCount = Number(
        this.db.prepare(`
          SELECT COUNT(*) AS count FROM group_context_messages
          WHERE source_id=? AND conversation_id=?
        `).get(sourceId, conversationId).count || 0,
      );
    } else {
      conversationCount += 1;
    }
    this.groupContextCounts.set(countKey, conversationCount);
    const maxMessages = Math.min(
      Math.max(Number(options.maxMessages) || 2000, 100),
      100_000,
    );
    const pruneExpired =
      this.groupContextWrites === 1 || this.groupContextWrites % 100 === 0;
    if (pruneExpired || conversationCount > maxMessages) {
      this.pruneGroupContext(sourceId, conversationId, {
        ...options,
        pruneExpired,
      });
      this.groupContextCounts.set(
        countKey,
        Number(
          this.db.prepare(`
            SELECT COUNT(*) AS count FROM group_context_messages
            WHERE source_id=? AND conversation_id=?
          `).get(sourceId, conversationId).count || 0,
        ),
      );
    }
    return {
      inserted: true,
      rowId: Number(result.lastInsertRowid),
      conversationId,
    };
  }

  pruneGroupContext(sourceId, conversationId, options = {}) {
    const retentionHours = Math.min(
      Math.max(Number(options.retentionHours) || 168, 1),
      24 * 365,
    );
    const maxMessages = Math.min(
      Math.max(Number(options.maxMessages) || 2000, 100),
      100_000,
    );
    const cutoff = now() - retentionHours * 60 * 60 * 1000;
    if (options.pruneExpired !== false) {
      this.db.prepare(
        "DELETE FROM group_context_messages WHERE timestamp<?",
      ).run(cutoff);
      this.groupContextCounts.clear();
    }
    this.db.prepare(`
      DELETE FROM group_context_messages
      WHERE source_id=? AND conversation_id=? AND id IN (
        SELECT id FROM group_context_messages
        WHERE source_id=? AND conversation_id=?
        ORDER BY timestamp DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `).run(
      sourceId,
      conversationId,
      sourceId,
      conversationId,
      maxMessages,
    );
  }

  groupContextBefore(message, options = {}) {
    if (message?.chatType !== "group") return [];
    const limit = Math.min(
      Math.max(Number(options.limit) || 0, 0),
      200,
    );
    if (!limit) return [];
    const retentionHours = Math.min(
      Math.max(Number(options.retentionHours) || 168, 1),
      24 * 365,
    );
    const sourceId = String(message.sourceId || "default");
    const conversationId = conversationIdFor(message);
    const position = this.db.prepare(`
      SELECT id, timestamp FROM group_context_messages
      WHERE source_id=? AND message_id=?
      LIMIT 1
    `);
    const upper = position.get(sourceId, String(message.messageId)) || {
      id: Number.MAX_SAFE_INTEGER,
      timestamp: Number(message.timestamp || now()),
    };
    const after = options.afterMessageId
      ? position.get(sourceId, String(options.afterMessageId))
      : null;
    const configuredLower =
      Number(upper.timestamp) - retentionHours * 60 * 60 * 1000;
    const lower = after || { id: 0, timestamp: configuredLower };
    const excluded = [
      ...new Set(
        (options.excludeMessageIds || [])
          .map((item) => String(item || "").trim())
          .filter(Boolean),
      ),
    ];
    const exclusionSql = excluded.length
      ? `AND message_id NOT IN (${excluded.map(() => "?").join(", ")})`
      : "";
    const rows = this.db.prepare(`
      SELECT * FROM group_context_messages
      WHERE source_id=? AND conversation_id=?
        AND (timestamp, id)>(?, ?)
        AND (timestamp, id)<(?, ?)
        ${exclusionSql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(
      sourceId,
      conversationId,
      Number(lower.timestamp),
      Number(lower.id),
      Number(upper.timestamp),
      Number(upper.id),
      ...excluded,
      limit,
    );
    return rows.reverse().map((row) => ({
      ...row,
      message: json(row.message_json, {}),
    }));
  }

  ingest(message, text = message.text, options = {}) {
    const scopeCaseId = caseIdFor(message);
    const assignedSession = options.useActiveSession
      ? ensureSessionScope(this.db, scopeCaseId)
      : null;
    const caseId = assignedSession?.target_case_id || scopeCaseId;
    const createdAt = now();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages(
        case_id, source_id, message_id, timestamp, direction,
        sender_id, sender_name, chat_type, chat_id, text,
        message_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      caseId,
      String(message.sourceId || "default"),
      String(message.messageId),
      Number(message.timestamp || createdAt),
      String(message.direction || "incoming"),
      String(message.senderId || ""),
      String(message.senderName || ""),
      String(message.chatType || "private"),
      String(message.chatId || ""),
      String(text || ""),
      JSON.stringify({ ...message, text: String(text || "") }),
      createdAt,
    );
    if (!result.changes) {
      const existing = this.db.prepare(`
        SELECT id, case_id FROM messages
        WHERE source_id=? AND message_id=?
        LIMIT 1
      `).get(
        String(message.sourceId || "default"),
        String(message.messageId),
      );
      return {
        inserted: false,
        caseId: existing?.case_id || caseId,
        scopeCaseId,
        messageRow: Number(existing?.id || 0),
      };
    }

    const messageRow = Number(result.lastInsertRowid);
    const baseTitle = this.caseBaseTitle(message);
    const title = assignedSession && assignedSession.session_id !== "main"
      ? `${baseTitle} / ${assignedSession.name}`
      : baseTitle;
    this.db.prepare(`
      INSERT INTO cases(
        case_id, source_id, source_name, chat_type, chat_id, title,
        status, unread_count, last_message_id, last_message_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'new', 1, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        source_name=excluded.source_name,
        title=excluded.title,
        status=CASE
          WHEN cases.status='running' THEN 'running'
          ELSE 'new'
        END,
        unread_count=cases.unread_count + 1,
        last_message_id=excluded.last_message_id,
        last_message_at=excluded.last_message_at,
        last_error='',
        updated_at=excluded.updated_at
    `).run(
      caseId,
      String(message.sourceId || "default"),
      String(
        message.sourceName ||
          message.sourceId ||
          (message.transport === "telegram" ? "Telegram" : "微信账号"),
      ),
      String(message.chatType || "private"),
      String(message.chatId || ""),
      title,
      messageRow,
      Number(message.timestamp || createdAt),
      createdAt,
      createdAt,
    );
    return { inserted: true, caseId, scopeCaseId, messageRow };
  }

  listCases(limit = 100) {
    return this.casePage({ limit }).cases;
  }

  caseSessionOptions(caseId) {
    const selected = this.sessionForTarget(caseId);
    if (!selected) return [];
    const state = this.db.prepare(`
      SELECT c.title, c.status AS case_status, c.last_message_at,
        c.last_message_id,
        (SELECT text FROM messages WHERE id=c.last_message_id) AS last_message,
        (SELECT COUNT(*) FROM drafts d WHERE d.case_id=c.case_id) AS draft_count,
        w.status AS worker_status,
        w.last_processed_message_id
      FROM cases c
      LEFT JOIN worker_sessions w ON w.case_id=c.case_id
      WHERE c.case_id=?
    `);
    return listSessions(this.db, selected.scope_case_id).map((session) => {
      const current = state.get(session.target_case_id) || null;
      return {
        key: session.session_id,
        name: session.name,
        targetCaseId: session.target_case_id,
        active: Boolean(session.is_active),
        selected: session.target_case_id === caseId,
        exists: Boolean(current),
        title: current?.title || "",
        caseStatus: current?.case_status || "",
        workerStatus: current?.worker_status || "",
        pending:
          Number(current?.last_message_id || 0) >
          Number(current?.last_processed_message_id || 0),
        lastMessage: current?.last_message || "",
        lastMessageAt: Number(current?.last_message_at || 0),
        draftCount: Number(current?.draft_count || 0),
      };
    });
  }

  casePage(options = {}) {
    const limit = Math.min(
      Math.max(Number(options.limit) || 50, 1),
      200,
    );
    const offset = Math.max(Number(options.offset) || 0, 0);
    const total = Number(
      this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM cases c
        WHERE NOT EXISTS (
          SELECT 1
          FROM assistant_sessions managed
          WHERE managed.target_case_id=c.case_id
            AND managed.session_id!='main'
        )
      `).get().count || 0,
    );
    const cases = this.db.prepare(`
      WITH managed_scope_state AS (
        SELECT root.target_case_id AS root_case_id,
          MAX(member_case.updated_at) AS latest_activity_at,
          MAX(CASE WHEN member_worker.status='running' THEN 1 ELSE 0 END)
            AS has_running_session
        FROM assistant_sessions root
        JOIN assistant_sessions member
          ON member.scope_case_id=root.scope_case_id
         AND member.deleted_at=0
        LEFT JOIN cases member_case
          ON member_case.case_id=member.target_case_id
        LEFT JOIN worker_sessions member_worker
          ON member_worker.case_id=member.target_case_id
        WHERE root.session_id='main' AND root.deleted_at=0
        GROUP BY root.target_case_id
      )
      SELECT c.*,
        (SELECT text FROM messages WHERE id=c.last_message_id) AS last_message,
        (SELECT COUNT(*) FROM drafts d WHERE d.case_id=c.case_id) AS draft_count,
        (SELECT status FROM worker_sessions w WHERE w.case_id=c.case_id) AS worker_status,
        COALESCE(scope.latest_activity_at, c.updated_at) AS managed_updated_at,
        COALESCE(scope.has_running_session, 0) AS managed_session_running
      FROM cases c
      LEFT JOIN managed_scope_state scope ON scope.root_case_id=c.case_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM assistant_sessions managed
        WHERE managed.target_case_id=c.case_id
          AND managed.session_id!='main'
      )
      ORDER BY managed_session_running DESC, managed_updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset).map((item) => ({
      ...item,
      caseSessionOptions: this.caseSessionOptions(item.case_id),
    }));
    return {
      cases,
      total,
      limit,
      offset,
      hasMore: offset + cases.length < total,
    };
  }

  caseRow(caseId) {
    return this.db.prepare("SELECT * FROM cases WHERE case_id=?").get(caseId);
  }

  pendingCaseIds(limit = 500) {
    return this.db.prepare(`
      SELECT case_id FROM cases
      WHERE status='new'
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(Math.min(Math.max(Number(limit) || 500, 1), 500))
      .map((row) => row.case_id);
  }

  messages(caseId, limit = 200) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE case_id=?
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp ASC, id ASC
    `).all(caseId, Math.min(Math.max(Number(limit) || 200, 1), 1000))
      .map((row) => ({ ...row, message: json(row.message_json, {}) }));
  }

  latestMessage(caseId) {
    const row = this.db.prepare(`
      SELECT * FROM messages
      WHERE case_id=?
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get(caseId);
    return row ? { ...row, message: json(row.message_json, {}) } : null;
  }

  messageByRowId(caseId, messageRowId) {
    const row = this.db.prepare(`
      SELECT * FROM messages
      WHERE case_id=? AND id=?
    `).get(caseId, Number(messageRowId));
    return row ? { ...row, message: json(row.message_json, {}) } : null;
  }

  updateMessageText(caseId, messageRowId, text) {
    const row = this.messageByRowId(caseId, messageRowId);
    if (!row) return false;
    const message = { ...row.message, text: String(text || "") };
    this.db.prepare(`
      UPDATE messages SET text=?, message_json=?
      WHERE case_id=? AND id=?
    `).run(
      String(text || ""),
      JSON.stringify(message),
      caseId,
      Number(messageRowId),
    );
    return true;
  }

  pendingMessages(caseId, afterMessageId = 0) {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE case_id=? AND id>?
      ORDER BY id ASC
    `).all(caseId, Number(afterMessageId || 0))
      .map((row) => ({ ...row, message: json(row.message_json, {}) }));
  }

  drafts(caseId, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM drafts
      WHERE case_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(caseId, Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map((row) => ({
        ...row,
        artifacts: json(row.artifacts_json, []),
        outbound: json(row.outbound_json, null),
      }));
  }

  progress(caseId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM progress
        WHERE case_id=?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      ) ORDER BY created_at ASC, id ASC
    `).all(caseId, Math.min(Math.max(Number(limit) || 100, 1), 500));
  }

  detail(caseId, options = {}) {
    const value = this.caseRow(caseId);
    if (!value) return null;
    const namedSession = this.sessionForTarget(caseId);
    const rootCase = namedSession?.scope_case_id
      ? this.caseRow(namedSession.scope_case_id)
      : null;
    const expanded = options.expanded === true;
    const messageLimit = expanded ? 1000 : 40;
    const draftLimit = expanded ? 200 : 8;
    const progressLimit = expanded ? 500 : 40;
    const messageTotal = Number(
      this.db.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE case_id=?",
      ).get(caseId).count || 0,
    );
    const draftTotal = Number(
      this.db.prepare(
        "SELECT COUNT(*) AS count FROM drafts WHERE case_id=?",
      ).get(caseId).count || 0,
    );
    const progressTotal = Number(
      this.db.prepare(
        "SELECT COUNT(*) AS count FROM progress WHERE case_id=?",
      ).get(caseId).count || 0,
    );
    const messages = this.messages(caseId, messageLimit);
    const drafts = this.drafts(caseId, draftLimit);
    const progress = this.progress(caseId, progressLimit);
    return {
      ...value,
      title: rootCase?.title || value.title,
      messages,
      drafts,
      progress,
      namedSession: namedSession
        ? {
            key: namedSession.session_id,
            name: namedSession.name,
            scopeCaseId: namedSession.scope_case_id,
            targetCaseId: namedSession.target_case_id,
            active: Boolean(namedSession.is_active),
          }
        : null,
      caseSessionOptions: this.caseSessionOptions(caseId),
      workerSession: (() => {
        const session = this.workerSession(caseId);
        return session
          ? {
              ...session,
              total_tokens:
                Number(session.input_tokens || 0)
                + Number(session.output_tokens || 0),
            }
          : null;
      })(),
      displayWindow: {
        expanded,
        messageTotal,
        messageShown: messages.length,
        messageTruncated: messages.length < messageTotal,
        draftTotal,
        draftShown: drafts.length,
        draftTruncated: drafts.length < draftTotal,
        progressTotal,
        progressShown: progress.length,
        progressTruncated: progress.length < progressTotal,
      },
    };
  }

  startRun(caseId, inputCutoffMessageId = 0) {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO worker_sessions(
        case_id, status, run_count, started_at, last_error,
        input_cutoff_message_id, updated_at
      ) VALUES (?, 'running', 1, ?, '', ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        status='running',
        run_count=worker_sessions.run_count + 1,
        started_at=excluded.started_at,
        finished_at=NULL,
        last_error='',
        input_cutoff_message_id=excluded.input_cutoff_message_id,
        updated_at=excluded.updated_at
    `).run(
      caseId,
      timestamp,
      Number(inputCutoffMessageId || 0),
      timestamp,
    );
    this.db.prepare(`
      UPDATE cases SET status='running', last_run_at=?, last_error='',
        updated_at=? WHERE case_id=?
    `).run(timestamp, timestamp, caseId);
    return this.db
      .prepare("SELECT * FROM worker_sessions WHERE case_id=?")
      .get(caseId);
  }

  workerSession(caseId) {
    return this.db
      .prepare("SELECT * FROM worker_sessions WHERE case_id=?")
      .get(caseId) || null;
  }

  recordProviderResult(caseId, result = {}) {
    const current = this.workerSession(caseId);
    if (!current) return;
    const hasCumulativeUsage =
      result.cumulativeUsage && typeof result.cumulativeUsage === "object";
    const usage = normalizeCodexUsage(
      hasCumulativeUsage ? result.cumulativeUsage : result.usage,
    );
    const totals = hasCumulativeUsage
      ? usage
      : {
          inputTokens: Number(current.input_tokens || 0) + usage.inputTokens,
          cachedInputTokens:
            Number(current.cached_input_tokens || 0)
            + usage.cachedInputTokens,
          cacheWriteInputTokens:
            Number(current.cache_write_input_tokens || 0)
            + usage.cacheWriteInputTokens,
          outputTokens:
            Number(current.output_tokens || 0) + usage.outputTokens,
          reasoningOutputTokens:
            Number(current.reasoning_output_tokens || 0)
            + usage.reasoningOutputTokens,
        };
    const cumulativeRequestCount = Number(result.cumulativeRequestCount || 0);
    const requestIncrement = Math.max(1, Number(result.requestCount || 0));
    const requestCount = hasCumulativeUsage && cumulativeRequestCount > 0
      ? cumulativeRequestCount
      : Number(current.request_count || 0) + requestIncrement;
    const model = String(result.model || current.model || "");
    const suppliedCost = result.cumulativeEstimatedCostUsd;
    const estimatedCostUsd =
      suppliedCost != null && Number.isFinite(Number(suppliedCost))
        ? Number(suppliedCost)
        : estimateCodexCostUsd(totals, model);
    this.db.prepare(`
      UPDATE worker_sessions SET
        codex_session_id=CASE
          WHEN ?!='' THEN ?
          ELSE codex_session_id
        END,
        model=CASE WHEN ?!='' THEN ? ELSE model END,
        reasoning_effort=CASE
          WHEN ?!='' THEN ?
          ELSE reasoning_effort
        END,
        request_count=?,
        input_tokens=?,
        cached_input_tokens=?,
        cache_write_input_tokens=?,
        output_tokens=?,
        reasoning_output_tokens=?,
        estimated_cost_usd=?,
        updated_at=?
      WHERE case_id=?
    `).run(
      String(result.sessionId || ""),
      String(result.sessionId || ""),
      String(result.model || ""),
      String(result.model || ""),
      String(result.effort || ""),
      String(result.effort || ""),
      requestCount,
      totals.inputTokens,
      totals.cachedInputTokens,
      totals.cacheWriteInputTokens,
      totals.outputTokens,
      totals.reasoningOutputTokens,
      estimatedCostUsd,
      now(),
      caseId,
    );
  }

  reconcileCodexUsage({
    codexHome = "",
    model = "",
    reasoningEffort = "",
    env = process.env,
  } = {}) {
    const marker = "codex_usage_reconciled_v1";
    if (this.runtimeSetting(marker, "") === "1") return { updated: 0 };
    const rows = this.db.prepare(`
      SELECT * FROM worker_sessions WHERE codex_session_id!=''
    `).all();
    let updated = 0;
    const update = this.db.prepare(`
      UPDATE worker_sessions SET
        model=?,
        reasoning_effort=?,
        request_count=?,
        input_tokens=?,
        cached_input_tokens=?,
        cache_write_input_tokens=?,
        output_tokens=?,
        reasoning_output_tokens=?,
        estimated_cost_usd=?,
        updated_at=?
      WHERE case_id=?
    `);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const sessionModel = String(row.model || model || "");
        const usage = parseCodexSessionUsage({
          sessionId: row.codex_session_id,
          codexHome,
          model: sessionModel,
          env,
        });
        if (!usage) continue;
        const effort = String(
          row.reasoning_effort
          || this.runtimeSetting(`assistant_effort:${row.case_id}`, "")
          || reasoningEffort
          || "",
        );
        update.run(
          sessionModel,
          effort,
          usage.cumulativeRequestCount,
          usage.cumulativeUsage.inputTokens,
          usage.cumulativeUsage.cachedInputTokens,
          usage.cumulativeUsage.cacheWriteInputTokens,
          usage.cumulativeUsage.outputTokens,
          usage.cumulativeUsage.reasoningOutputTokens,
          usage.cumulativeEstimatedCostUsd,
          now(),
          row.case_id,
        );
        updated += 1;
      }
      this.setRuntimeSetting(marker, "1");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { updated };
  }

  resetCodexSession(caseId) {
    const session = this.workerSession(caseId);
    if (!session) return false;
    this.db.prepare(`
      UPDATE worker_sessions SET codex_session_id='', updated_at=?
      WHERE case_id=?
    `).run(now(), caseId);
    this.addProgress(caseId, session.run_count, "Codex session 已重置");
    return true;
  }

  markControlHandled(caseId, messageRowId) {
    const timestamp = now();
    const messageId = Number(messageRowId || 0);
    this.db.prepare(`
      INSERT INTO worker_sessions(
        case_id, status, run_count, finished_at, last_error,
        last_processed_message_id, input_cutoff_message_id, updated_at
      ) VALUES (?, 'draft_ready', 0, ?, '', ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        status=CASE
          WHEN worker_sessions.status='running' THEN 'running'
          ELSE 'draft_ready'
        END,
        finished_at=CASE
          WHEN worker_sessions.status='running'
            THEN worker_sessions.finished_at
          ELSE excluded.finished_at
        END,
        last_error='',
        last_processed_message_id=MAX(
          worker_sessions.last_processed_message_id,
          excluded.last_processed_message_id
        ),
        input_cutoff_message_id=MAX(
          worker_sessions.input_cutoff_message_id,
          excluded.input_cutoff_message_id
        ),
        updated_at=excluded.updated_at
    `).run(caseId, timestamp, messageId, messageId, timestamp);
  }

  addProgress(caseId, runCount, message, level = "info") {
    this.db.prepare(`
      INSERT INTO progress(case_id, run_count, level, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(caseId, Number(runCount || 0), level, String(message), now());
  }

  addDraft(caseId, text, model = "", options = {}) {
    const timestamp = now();
    const triggerMessageId = Number(options.triggerMessageId || 0);
    const inputCutoffMessageId = Number(options.inputCutoffMessageId || 0);
    const result = this.db.prepare(`
      INSERT INTO drafts(
        case_id, text, status, model, trigger_message_id,
        input_cutoff_message_id, artifacts_json, created_at
      )
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)
    `).run(
      caseId,
      String(text),
      String(model || ""),
      triggerMessageId || null,
      inputCutoffMessageId,
      JSON.stringify(options.artifacts || []),
      timestamp,
    );
    this.db.prepare(`
      UPDATE cases SET
        status=CASE
          WHEN status='running' THEN 'running'
          WHEN last_message_id>? THEN 'new'
          ELSE 'draft_ready'
        END,
        unread_count=CASE WHEN last_message_id>? THEN unread_count ELSE 0 END,
        updated_at=? WHERE case_id=?
    `).run(inputCutoffMessageId, inputCutoffMessageId, timestamp, caseId);
    return Number(result.lastInsertRowid);
  }

  finishRun(
    caseId,
    status = "draft_ready",
    error = "",
    processedThroughMessageId = 0,
  ) {
    const timestamp = now();
    const processed = Number(processedThroughMessageId || 0);
    this.db.prepare(`
      UPDATE worker_sessions
      SET status=?, finished_at=?, last_error=?,
        last_processed_message_id=CASE
          WHEN ?>last_processed_message_id THEN ?
          ELSE last_processed_message_id
        END,
        updated_at=?
      WHERE case_id=?
    `).run(
      status,
      timestamp,
      String(error || ""),
      processed,
      processed,
      timestamp,
      caseId,
    );
    this.db.prepare(`
      UPDATE cases SET
        status=CASE
          WHEN ?>0 AND last_message_id>(
            SELECT last_processed_message_id
            FROM worker_sessions
            WHERE case_id=?
          ) THEN 'new'
          ELSE ?
        END,
        last_error=?,
        updated_at=?
      WHERE case_id=?
    `).run(
      processed,
      caseId,
      status,
      String(error || ""),
      timestamp,
      caseId,
    );
  }

  markSent(caseId, draftId, outbound) {
    const timestamp = now();
    this.db.prepare(`
      UPDATE drafts SET status='sent', sent_at=?, outbound_json=?, error=''
      WHERE id=? AND case_id=?
    `).run(timestamp, JSON.stringify(outbound || {}), Number(draftId), caseId);
    this.db.prepare(`
      UPDATE cases SET
        status=CASE
          WHEN status='running' THEN 'running'
          WHEN last_message_id>(
            MAX(
              COALESCE((
                SELECT input_cutoff_message_id FROM drafts WHERE id=?
              ), 0),
              COALESCE((
                SELECT last_processed_message_id
                FROM worker_sessions
                WHERE case_id=?
              ), 0)
            )
          ) THEN 'new'
          ELSE 'replied'
        END,
        unread_count=CASE
          WHEN last_message_id>(
            MAX(
              COALESCE((
                SELECT input_cutoff_message_id FROM drafts WHERE id=?
              ), 0),
              COALESCE((
                SELECT last_processed_message_id
                FROM worker_sessions
                WHERE case_id=?
              ), 0)
            )
          ) THEN unread_count
          ELSE 0
        END,
        last_error='',
        updated_at=?
      WHERE case_id=?
    `).run(
      Number(draftId),
      caseId,
      Number(draftId),
      caseId,
      timestamp,
      caseId,
    );
  }

  markDraftError(caseId, draftId, error) {
    this.db.prepare(`
      UPDATE drafts SET error=?
      WHERE id=? AND case_id=? AND status!='sent'
    `).run(String(error || ""), Number(draftId), caseId);
  }

  draft(caseId, draftId) {
    const row = this.db.prepare(`
      SELECT * FROM drafts WHERE case_id=? AND id=?
    `).get(caseId, Number(draftId));
    return row
      ? {
          ...row,
          artifacts: json(row.artifacts_json, []),
          outbound: json(row.outbound_json, null),
        }
      : null;
  }

  stats() {
    const summary = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(status='new') AS new_count,
        SUM(status='running') AS running_count,
        SUM(status='draft_ready') AS draft_count,
        SUM(status='replied') AS replied_count,
        SUM(status='failed') AS failed_count
      FROM cases
    `).get();
    return {
      total: Number(summary.total || 0),
      new_count: Number(summary.new_count || 0),
      running_count: Number(summary.running_count || 0),
      draft_count: Number(summary.draft_count || 0),
      replied_count: Number(summary.replied_count || 0),
      failed_count: Number(summary.failed_count || 0),
      messages: this.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
      drafts: this.db.prepare("SELECT COUNT(*) AS count FROM drafts").get().count,
    };
  }
}

export { caseIdFor };
