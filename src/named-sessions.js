import crypto from "node:crypto";

export const MAIN_SESSION_ID = "main";
export const MAIN_SESSION_NAME = "main";

export function normalizeSessionName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return /^(?:main|default)$/i.test(name) ? MAIN_SESSION_NAME : name;
}

export function validSessionName(value) {
  const name = normalizeSessionName(value);
  return Boolean(
    name
    && name.length <= 40
    && !/[\u0000-\u001f\u007f/\\]/.test(name),
  );
}

export function parseSessionCommand(value) {
  const text = String(value || "").trim();
  if (/^\/sessions\s*$/i.test(text)) {
    return { type: "session", action: "list", name: "" };
  }
  const match = text.match(/^\/session(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const argument = String(match[1] || "").replace(/\s+/g, " ").trim();
  if (!argument || /^(?:current|show)$/i.test(argument)) {
    return { type: "session", action: "show", name: "" };
  }
  if (/^list$/i.test(argument)) {
    return { type: "session", action: "invalid", name: "" };
  }
  const newMatch = argument.match(/^new(?:\s+([\s\S]+))?$/i);
  if (newMatch) {
    return {
      type: "session",
      action: "new",
      name: normalizeSessionName(newMatch[1] || ""),
    };
  }
  const useMatch = argument.match(/^use(?:\s+([\s\S]+))?$/i);
  if (useMatch) {
    return {
      type: "session",
      action: useMatch[1] ? "use" : "invalid",
      name: normalizeSessionName(useMatch[1] || ""),
    };
  }
  const deleteMatch = argument.match(/^delete(?:\s+([\s\S]+))?$/i);
  if (deleteMatch) {
    return {
      type: "session",
      action: deleteMatch[1] ? "delete" : "invalid",
      name: normalizeSessionName(deleteMatch[1] || ""),
    };
  }
  return {
    type: "session",
    action: "use",
    name: normalizeSessionName(argument),
  };
}

export function installNamedSessionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_session_scopes (
      scope_case_id TEXT PRIMARY KEY,
      active_session_id TEXT NOT NULL DEFAULT 'main',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      scope_case_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      target_case_id TEXT NOT NULL UNIQUE,
      deleted_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY(scope_case_id, session_id),
      UNIQUE(scope_case_id, name)
    );
    CREATE INDEX IF NOT EXISTS assistant_sessions_target
      ON assistant_sessions(target_case_id);
  `);
}

export function ensureSessionScope(db, scopeCaseId, timestamp = Date.now()) {
  const scope = String(scopeCaseId || "").trim();
  if (!scope) throw new Error("scope case id is required");
  db.prepare(`
    INSERT OR IGNORE INTO assistant_session_scopes(
      scope_case_id, active_session_id, created_at, updated_at
    ) VALUES (?, 'main', ?, ?)
  `).run(scope, timestamp, timestamp);
  db.prepare(`
    INSERT OR IGNORE INTO assistant_sessions(
      scope_case_id, session_id, name, target_case_id,
      deleted_at, created_at, last_used_at
    ) VALUES (?, 'main', 'main', ?, 0, ?, ?)
  `).run(scope, scope, timestamp, timestamp);
  return activeSession(db, scope);
}

export function activeSession(db, scopeCaseId) {
  return db.prepare(`
    SELECT s.*, 1 AS is_active
    FROM assistant_session_scopes p
    JOIN assistant_sessions s
      ON s.scope_case_id=p.scope_case_id
     AND s.session_id=p.active_session_id
    WHERE p.scope_case_id=? AND s.deleted_at=0
    LIMIT 1
  `).get(String(scopeCaseId || "")) || null;
}

export function sessionByName(db, scopeCaseId, name) {
  return db.prepare(`
    SELECT s.*,
      CASE WHEN p.active_session_id=s.session_id THEN 1 ELSE 0 END AS is_active
    FROM assistant_sessions s
    JOIN assistant_session_scopes p ON p.scope_case_id=s.scope_case_id
    WHERE s.scope_case_id=? AND s.name=? COLLATE NOCASE AND s.deleted_at=0
    LIMIT 1
  `).get(
    String(scopeCaseId || ""),
    normalizeSessionName(name),
  ) || null;
}

export function sessionForTarget(db, targetCaseId) {
  return db.prepare(`
    SELECT s.*,
      CASE WHEN p.active_session_id=s.session_id THEN 1 ELSE 0 END AS is_active
    FROM assistant_sessions s
    JOIN assistant_session_scopes p ON p.scope_case_id=s.scope_case_id
    WHERE s.target_case_id=?
    LIMIT 1
  `).get(String(targetCaseId || "")) || null;
}

export function listSessions(db, scopeCaseId) {
  return db.prepare(`
    SELECT s.*,
      CASE WHEN p.active_session_id=s.session_id THEN 1 ELSE 0 END AS is_active
    FROM assistant_sessions s
    JOIN assistant_session_scopes p ON p.scope_case_id=s.scope_case_id
    WHERE s.scope_case_id=? AND s.deleted_at=0
    ORDER BY is_active DESC, s.created_at ASC, s.session_id ASC
  `).all(String(scopeCaseId || ""));
}

function nextAutomaticName(db, scopeCaseId) {
  const names = new Set(
    listSessions(db, scopeCaseId)
      .map((row) => String(row.name || "").toLowerCase()),
  );
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `session-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("unable to allocate session name");
}

export function activateSession(
  db,
  scopeCaseId,
  name,
  timestamp = Date.now(),
) {
  ensureSessionScope(db, scopeCaseId, timestamp);
  const target = sessionByName(db, scopeCaseId, name);
  if (!target) return null;
  db.prepare(`
    UPDATE assistant_session_scopes
    SET active_session_id=?, updated_at=?
    WHERE scope_case_id=?
  `).run(target.session_id, timestamp, String(scopeCaseId));
  db.prepare(`
    UPDATE assistant_sessions
    SET last_used_at=?
    WHERE scope_case_id=? AND session_id=?
  `).run(timestamp, String(scopeCaseId), target.session_id);
  return sessionByName(db, scopeCaseId, target.name);
}

export function createSession(db, scopeCaseId, requestedName = "") {
  const timestamp = Date.now();
  ensureSessionScope(db, scopeCaseId, timestamp);
  const name = normalizeSessionName(requestedName)
    || nextAutomaticName(db, scopeCaseId);
  if (!validSessionName(name) || name === MAIN_SESSION_NAME) {
    throw new Error(
      "session 名称需为 1-40 个字符，不能包含斜杠；main/default 是保留名",
    );
  }
  if (sessionByName(db, scopeCaseId, name)) {
    throw new Error(`session「${name}」已存在`);
  }
  const sessionId = crypto.randomUUID().replaceAll("-", "");
  const targetCaseId = `${scopeCaseId}:session:${sessionId}`;
  db.prepare(`
    INSERT INTO assistant_sessions(
      scope_case_id, session_id, name, target_case_id,
      deleted_at, created_at, last_used_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(
    String(scopeCaseId),
    sessionId,
    name,
    targetCaseId,
    timestamp,
    timestamp,
  );
  activateSession(db, scopeCaseId, name, timestamp);
  return sessionByName(db, scopeCaseId, name);
}

export function deleteSession(db, scopeCaseId, name) {
  ensureSessionScope(db, scopeCaseId);
  const target = sessionByName(db, scopeCaseId, name);
  if (!target) return { deleted: false, reason: "not-found", session: null };
  if (target.session_id === MAIN_SESSION_ID) {
    return { deleted: false, reason: "main", session: target };
  }
  if (target.is_active) {
    return { deleted: false, reason: "active", session: target };
  }
  const timestamp = Date.now();
  db.prepare(`
    UPDATE assistant_sessions
    SET name=?, deleted_at=?, last_used_at=?
    WHERE scope_case_id=? AND session_id=? AND deleted_at=0
  `).run(
    `__deleted__${target.session_id}`,
    timestamp,
    timestamp,
    String(scopeCaseId),
    target.session_id,
  );
  return { deleted: true, reason: "", session: target };
}
