"use strict";

// Manual session retention keeps only the metadata needed to rebuild a quiet
// HUD/Dashboard card after the live session record is gone. It deliberately
// excludes transcript paths, assistant output, process ids, permissions, and
// automation state. Historical cards are restored as idle/non-focusable so a
// restart cannot resurrect work, notifications, or stale terminal handles.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hasStoredClaudeSessionEvidence } = require("./claude-desktop-session");
const { isClaudeBashCodexWorkerSession } = require("./codex-background-worker");

const FILE_VERSION = 1;
const DEFAULT_PERSIST_PATH = path.join(os.homedir(), ".clawd", "retained-sessions.json");
const PERSIST_DEBOUNCE_MS = 150;
const CLAUDE_NEGATIVE_EVIDENCE_TTL_MS = 60 * 1000;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function nullableText(value, maxLength) {
  const text = cleanText(value, maxLength);
  return text || null;
}

function sanitizeSession(id, session) {
  const sessionId = cleanText(id, 640);
  if (
    !sessionId
    || !session
    || session.headless === true
    || isClaudeBashCodexWorkerSession(session)
  ) return null;
  const agentId = nullableText(session.agentId, 96);
  if (!agentId) return null;

  const updatedAt = Number(session.updatedAt);
  return {
    id: sessionId,
    profileId: nullableText(session.profileId, 160) || "local",
    rawSessionId: nullableText(session.rawSessionId, 640) || sessionId,
    agentId,
    sessionTitle: nullableText(session.sessionTitle, 360),
    cwd: cleanText(session.cwd, 2048),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : Date.now(),
    host: nullableText(session.host, 256),
    wslDistro: nullableText(session.wslDistro, 160),
    platform: nullableText(session.platform, 64),
    model: nullableText(session.model, 160),
    provider: nullableText(session.provider, 160),
    codexOriginator: nullableText(session.codexOriginator, 160),
    codexSource: nullableText(session.codexSource, 160),
  };
}

function toHistoricalSession(record) {
  return {
    state: "idle",
    updatedAt: record.updatedAt,
    displayHint: null,
    profileId: record.profileId,
    rawSessionId: record.rawSessionId,
    agentId: record.agentId,
    sessionTitle: record.sessionTitle,
    cwd: record.cwd,
    host: record.host,
    wslDistro: record.wslDistro,
    platform: record.platform,
    model: record.model,
    provider: record.provider,
    codexOriginator: record.codexOriginator,
    codexSource: record.codexSource,
    sourcePid: null,
    agentPid: null,
    pidReachable: false,
    headless: false,
    recentEvents: [],
    contextUsage: null,
    requiresCompletionAck: false,
    manualRetained: true,
  };
}

function createManualSessionRetentionStore(options = {}) {
  const persistPath = options.persistPath || null;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  const checkClaudeEvidence = typeof options.hasStoredClaudeSessionEvidence === "function"
    ? options.hasStoredClaudeSessionEvidence
    : hasStoredClaudeSessionEvidence;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const records = new Map();
  const claudeEvidenceCache = new Map();
  let persistTimer = null;

  function hasRecoverableClaudeEvidence(clean, source, { useCache = true } = {}) {
    if (clean.agentId !== "claude-code" || clean.sessionTitle) return true;
    const cacheKey = clean.rawSessionId;
    const checkedAt = now();
    const cached = useCache ? claudeEvidenceCache.get(cacheKey) : null;
    if (
      cached
      && (cached.hasEvidence || checkedAt - cached.checkedAt < CLAUDE_NEGATIVE_EVIDENCE_TTL_MS)
    ) {
      return cached.hasEvidence;
    }

    let hasEvidence = false;
    try {
      hasEvidence = Boolean(checkClaudeEvidence({
        ...clean,
        transcriptPath: nullableText(source && source.transcriptPath, 4096),
      }, options));
    } catch (_err) {}
    claudeEvidenceCache.set(cacheKey, { hasEvidence, checkedAt });
    return hasEvidence;
  }

  function load() {
    if (!persistPath) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(persistPath, "utf8"));
    } catch (err) {
      if (err && err.code !== "ENOENT") logWarn("Clawd: retained sessions file could not be read:", err);
      return;
    }
    if (!parsed || parsed.version !== FILE_VERSION || !Array.isArray(parsed.sessions)) return;
    let pruned = false;
    for (const item of parsed.sessions) {
      if (isClaudeBashCodexWorkerSession(item)) {
        pruned = true;
        continue;
      }
      const clean = sanitizeSession(item && item.id, item);
      if (!clean) continue;
      if (!hasRecoverableClaudeEvidence(clean, item, { useCache: false })) {
        pruned = true;
        continue;
      }
      records.set(clean.id, clean);
    }
    if (pruned) schedulePersist();
  }

  function persistNow() {
    if (!persistPath) return false;
    const parent = path.dirname(persistPath);
    const tempPath = `${persistPath}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        tempPath,
        `${JSON.stringify({ version: FILE_VERSION, sessions: [...records.values()] }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      fs.renameSync(tempPath, persistPath);
      try { fs.chmodSync(persistPath, 0o600); } catch {}
      return true;
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      logWarn("Clawd: retained sessions file could not be written:", err);
      return false;
    }
  }

  function schedulePersist() {
    if (!persistPath || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
    if (persistTimer && typeof persistTimer.unref === "function") persistTimer.unref();
  }

  function upsertSession(id, session) {
    const clean = sanitizeSession(id, session);
    if (!clean) return false;
    const previous = records.get(clean.id);
    if (!previous && !hasRecoverableClaudeEvidence(clean, session)) return false;
    if (previous && JSON.stringify(previous) === JSON.stringify(clean)) return false;
    records.set(clean.id, clean);
    schedulePersist();
    return true;
  }

  function upsertSessions(sessions) {
    let changed = false;
    if (!sessions || typeof sessions[Symbol.iterator] !== "function") return false;
    for (const [id, session] of sessions) {
      if (upsertSession(id, session)) changed = true;
    }
    return changed;
  }

  function remove(id) {
    const sessionId = cleanText(id, 640);
    if (!sessionId || !records.delete(sessionId)) return false;
    schedulePersist();
    return true;
  }

  function historicalSessions() {
    return new Map([...records.values()].map((record) => [record.id, toHistoricalSession(record)]));
  }

  function listRecords() {
    return [...records.values()].map((record) => ({ ...record }));
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      return persistNow();
    }
    return true;
  }

  load();
  return { upsertSession, upsertSessions, remove, historicalSessions, listRecords, flush };
}

module.exports = {
  FILE_VERSION,
  DEFAULT_PERSIST_PATH,
  PERSIST_DEBOUNCE_MS,
  sanitizeSession,
  toHistoricalSession,
  createManualSessionRetentionStore,
};
