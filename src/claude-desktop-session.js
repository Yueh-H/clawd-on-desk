"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLAUDE_CLI_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_DESKTOP_SESSION_ID_RE = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_RECORD_MAX_BYTES = 1024 * 1024;
const DESKTOP_RECORD_HEADER_BYTES = 8192;
const DESKTOP_SCAN_MAX_ENTRIES = 50000;
const DESKTOP_SCAN_MAX_DEPTH = 5;
const TRANSCRIPT_SCAN_MAX_PROJECTS = 10000;
const DEFAULT_DESKTOP_SCAN_CACHE_TTL_MS = 5000;
const desktopScanCache = new Map();

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeClaudeCliSessionId(value) {
  const sessionId = normalizeString(value).toLowerCase();
  return CLAUDE_CLI_SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

function normalizeClaudeDesktopSessionId(value) {
  const sessionId = normalizeString(value);
  return CLAUDE_DESKTOP_SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

function defaultClaudeDesktopSessionRoots(options = {}) {
  if (Array.isArray(options.desktopSessionRoots)) {
    return options.desktopSessionRoots.map(normalizeString).filter(Boolean);
  }
  if (normalizeString(options.desktopSessionRoot)) {
    return [normalizeString(options.desktopSessionRoot)];
  }

  const osPlatform = normalizeString(options.osPlatform || process.platform).toLowerCase();
  const homeDir = normalizeString(options.homeDir) || os.homedir();
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  if (osPlatform === "darwin") {
    return [path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions")];
  }
  if (osPlatform === "win32") {
    const appData = normalizeString(env.APPDATA);
    return appData ? [path.join(appData, "Claude", "claude-code-sessions")] : [];
  }
  const configDir = normalizeString(env.XDG_CONFIG_HOME) || path.join(homeDir, ".config");
  return [path.join(configDir, "Claude", "claude-code-sessions")];
}

function parseActivityTime(record) {
  for (const value of [
    record && record.lastActivityAt,
    record && record.lastFocusedAt,
    record && record.updatedAt,
    record && record.createdAt,
  ]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function candidateRank(candidate, requestedCwd) {
  return [
    candidate.isArchived ? 0 : 1,
    requestedCwd && candidate.cwd === requestedCwd ? 1 : 0,
    candidate.hasTitle ? 1 : 0,
    candidate.activityTime,
  ];
}

function outranks(candidate, current, requestedCwd) {
  if (!current) return true;
  const nextRank = candidateRank(candidate, requestedCwd);
  const currentRank = candidateRank(current, requestedCwd);
  for (let index = 0; index < nextRank.length; index += 1) {
    if (nextRank[index] !== currentRank[index]) return nextRank[index] > currentRank[index];
  }
  return candidate.sessionId < current.sessionId;
}

function readDesktopRecordIdentity(filePath, options = {}) {
  const lstatSync = options.lstatSync || fs.lstatSync;
  const openSync = options.openSync || fs.openSync;
  const readSync = options.readSync || fs.readSync;
  const closeSync = options.closeSync || fs.closeSync;
  let fd;
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > DESKTOP_RECORD_MAX_BYTES) {
      return null;
    }
    fd = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, DESKTOP_RECORD_HEADER_BYTES));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString("utf8");
    const cliMatch = header.match(/"cliSessionId"\s*:\s*"([0-9a-f-]+)"/i);
    const localMatch = header.match(/"sessionId"\s*:\s*"(local_[0-9a-f-]+)"/i);
    const cliSessionId = normalizeClaudeCliSessionId(cliMatch && cliMatch[1]);
    const sessionId = normalizeClaudeDesktopSessionId(localMatch && localMatch[1]);
    if (!cliSessionId || !sessionId) return null;
    return { sessionId, cliSessionId, filePath };
  } catch (_err) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (_err) {}
    }
  }
}

function readDesktopCandidate(identity, options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  try {
    const record = JSON.parse(readFileSync(identity.filePath, "utf8"));
    const cliSessionId = normalizeClaudeCliSessionId(record && record.cliSessionId);
    const sessionId = normalizeClaudeDesktopSessionId(record && record.sessionId);
    if (cliSessionId !== identity.cliSessionId || sessionId !== identity.sessionId) return null;
    return {
      sessionId,
      cliSessionId,
      isArchived: record.isArchived === true || record.archived === true,
      cwd: normalizeString(record.cwd),
      hasTitle: Boolean(normalizeString(record.title || record.name)),
      activityTime: parseActivityTime(record),
    };
  } catch (_err) {
    return null;
  }
}

function scanClaudeDesktopSessions(options = {}) {
  const roots = defaultClaudeDesktopSessionRoots(options);
  const cacheTtlMs = Number.isFinite(options.desktopScanCacheTtlMs)
    ? Math.max(0, options.desktopScanCacheTtlMs)
    : DEFAULT_DESKTOP_SCAN_CACHE_TTL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const cacheKey = roots.join("\u0000");
  const canCache = cacheKey
    && !options.readdirSync
    && !options.lstatSync
    && !options.openSync
    && !options.readSync
    && !options.closeSync
    && !options.readFileSync
    && cacheTtlMs > 0;
  const cached = canCache ? desktopScanCache.get(cacheKey) : null;
  if (cached && now() < cached.expiresAt) return cached.sessionsByCliId;

  const readdirSync = options.readdirSync || fs.readdirSync;
  const stack = roots.map((root) => ({ root, depth: 0 }));
  const sessionsByCliId = new Map();
  let visited = 0;

  while (stack.length && visited < DESKTOP_SCAN_MAX_ENTRIES) {
    const { root, depth } = stack.pop();
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const item of entries) {
      visited += 1;
      if (visited > DESKTOP_SCAN_MAX_ENTRIES) break;
      const itemPath = path.join(root, item.name);
      if (item.isDirectory() && !item.isSymbolicLink() && depth < DESKTOP_SCAN_MAX_DEPTH) {
        stack.push({ root: itemPath, depth: depth + 1 });
        continue;
      }
      if (
        !item.isFile()
        || item.isSymbolicLink()
        || !/^local_[0-9a-f-]+\.json$/i.test(item.name)
      ) {
        continue;
      }
      const expectedLocalSessionId = item.name.slice(0, -".json".length);
      const identity = readDesktopRecordIdentity(itemPath, options);
      if (
        !identity
        || identity.sessionId.toLowerCase() !== expectedLocalSessionId.toLowerCase()
      ) {
        continue;
      }
      const identities = sessionsByCliId.get(identity.cliSessionId) || [];
      identities.push(identity);
      sessionsByCliId.set(identity.cliSessionId, identities);
    }
  }

  if (canCache) {
    desktopScanCache.set(cacheKey, {
      expiresAt: now() + cacheTtlMs,
      sessionsByCliId,
    });
  }
  return sessionsByCliId;
}

function findClaudeDesktopSession(cliSessionId, options = {}) {
  const expectedCliSessionId = normalizeClaudeCliSessionId(cliSessionId);
  if (!expectedCliSessionId) return null;

  const requestedCwd = normalizeString(options.cwd);
  const identities = scanClaudeDesktopSessions(options).get(expectedCliSessionId) || [];
  let best = null;
  for (const identity of identities) {
    const candidate = readDesktopCandidate(identity, options);
    if (candidate && outranks(candidate, best, requestedCwd)) best = candidate;
  }

  if (!best) return null;
  return {
    sessionId: best.sessionId,
    cliSessionId: best.cliSessionId,
    isArchived: best.isArchived,
    lastActivityAt: best.activityTime || null,
  };
}

function buildClaudeDesktopSessionUrl(sessionId) {
  const localSessionId = normalizeClaudeDesktopSessionId(sessionId);
  return localSessionId
    ? `claude://claude.ai/epitaxy/${encodeURIComponent(localSessionId)}`
    : null;
}

function isRegularFile(filePath, options = {}) {
  const lstatSync = options.lstatSync || fs.lstatSync;
  try {
    const stat = lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (_err) {
    return false;
  }
}

function hasClaudeTranscriptFile(entry, options = {}) {
  const directPath = normalizeString(entry && entry.transcriptPath);
  if (directPath && isRegularFile(directPath, options)) return true;

  const rawSessionId = normalizeClaudeCliSessionId(
    entry && (entry.rawSessionId || entry.cliSessionId || entry.id)
  );
  if (!rawSessionId) return false;
  const homeDir = normalizeString(options.homeDir) || os.homedir();
  const projectsRoot = normalizeString(options.projectsRoot)
    || path.join(homeDir, ".claude", "projects");
  const readdirSync = options.readdirSync || fs.readdirSync;
  let projects;
  try {
    projects = readdirSync(projectsRoot, { withFileTypes: true });
  } catch (_err) {
    return false;
  }

  let visited = 0;
  for (const project of projects) {
    visited += 1;
    if (visited > TRANSCRIPT_SCAN_MAX_PROJECTS) break;
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    if (isRegularFile(path.join(projectsRoot, project.name, `${rawSessionId}.jsonl`), options)) {
      return true;
    }
  }
  return false;
}

function hasStoredClaudeSessionEvidence(entry, options = {}) {
  const rawSessionId = normalizeClaudeCliSessionId(
    entry && (entry.rawSessionId || entry.cliSessionId || entry.id)
  );
  if (!rawSessionId) return false;
  return Boolean(findClaudeDesktopSession(rawSessionId, {
    ...options,
    cwd: normalizeString(entry && entry.cwd),
  })) || hasClaudeTranscriptFile(entry, options);
}

module.exports = {
  CLAUDE_CLI_SESSION_ID_RE,
  CLAUDE_DESKTOP_SESSION_ID_RE,
  DESKTOP_RECORD_MAX_BYTES,
  buildClaudeDesktopSessionUrl,
  defaultClaudeDesktopSessionRoots,
  findClaudeDesktopSession,
  hasClaudeTranscriptFile,
  hasStoredClaudeSessionEvidence,
  normalizeClaudeCliSessionId,
  normalizeClaudeDesktopSessionId,
};
