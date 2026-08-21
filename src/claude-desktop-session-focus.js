"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseSessionKey } = require("./session-key");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_SESSION_ID_RE = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_DIRECTORY_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_CACHE_TTL_MS = 5000;
const DEFAULT_MAX_METADATA_FILES = 5000;
const DEFAULT_MAX_METADATA_BYTES = 1024 * 1024;
const METADATA_HEADER_BYTES = 4096;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getDefaultClaudeDesktopMetadataRoot(options = {}) {
  const platform = normalizeString(options.platform || process.platform).toLowerCase();
  if (platform !== "darwin") return null;
  const homeDir = normalizeString(options.homeDir) || os.homedir();
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
  );
}

function getClaudeCliSessionId(entry) {
  if (!entry || entry.agentId !== "claude-code" || entry.host || entry.platform === "webui") {
    return null;
  }

  for (const value of [entry.rawSessionId, entry.id]) {
    const sessionId = normalizeString(value);
    if (!sessionId) continue;
    const identity = parseSessionKey(sessionId);
    const rawSessionId = identity ? identity.rawSessionId : sessionId;
    if (UUID_RE.test(rawSessionId)) return rawSessionId.toLowerCase();
  }
  return null;
}

function buildClaudeDesktopSessionUrl(localSessionId) {
  const normalized = normalizeString(localSessionId);
  if (!LOCAL_SESSION_ID_RE.test(normalized)) return null;
  return `claude://claude.ai/epitaxy/${encodeURIComponent(normalized)}`;
}

function listSafeDirectories(fsImpl, rootPath) {
  try {
    return fsImpl.readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SAFE_DIRECTORY_NAME_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (_err) {
    return [];
  }
}

function readMetadataIdentity(fsImpl, filePath, expectedLocalSessionId, maxMetadataBytes) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch (_err) {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxMetadataBytes) return null;

  let fileHandle = null;
  try {
    fileHandle = fsImpl.openSync(filePath, "r");
    const headerBuffer = Buffer.alloc(Math.min(stat.size, METADATA_HEADER_BYTES));
    const bytesRead = fsImpl.readSync(fileHandle, headerBuffer, 0, headerBuffer.length, 0);
    const header = headerBuffer.toString("utf8", 0, bytesRead);
    const localMatch = header.match(/"sessionId"\s*:\s*"(local_[0-9a-f-]+)"/i);
    const cliMatch = header.match(/"cliSessionId"\s*:\s*"([0-9a-f-]+)"/i);
    if (
      localMatch
      && cliMatch
      && LOCAL_SESSION_ID_RE.test(localMatch[1])
      && UUID_RE.test(cliMatch[1])
      && localMatch[1].toLowerCase() === expectedLocalSessionId.toLowerCase()
    ) {
      return {
        cliSessionId: cliMatch[1].toLowerCase(),
        localSessionId: localMatch[1],
      };
    }
  } catch (_err) {
    return null;
  } finally {
    if (fileHandle !== null) {
      try {
        fsImpl.closeSync(fileHandle);
      } catch (_err) {
        // Best-effort close; a failed metadata read must not block terminal focus.
      }
    }
  }

  // Current Claude Desktop metadata stores both IDs at the beginning of the
  // file. Keep a bounded JSON fallback so a harmless field-order change does
  // not break exact focus, while still refusing unexpectedly large files.
  try {
    const metadata = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    const localSessionId = normalizeString(metadata && metadata.sessionId);
    const cliSessionId = normalizeString(metadata && metadata.cliSessionId);
    if (
      !LOCAL_SESSION_ID_RE.test(localSessionId)
      || !UUID_RE.test(cliSessionId)
      || localSessionId.toLowerCase() !== expectedLocalSessionId.toLowerCase()
    ) {
      return null;
    }
    return {
      cliSessionId: cliSessionId.toLowerCase(),
      localSessionId,
    };
  } catch (_err) {
    return null;
  }
}

function scanClaudeDesktopSessionMetadata(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const metadataRoot = normalizeString(options.metadataRoot);
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0
    ? options.maxFiles
    : DEFAULT_MAX_METADATA_FILES;
  const maxMetadataBytes = Number.isInteger(options.maxMetadataBytes) && options.maxMetadataBytes > 0
    ? options.maxMetadataBytes
    : DEFAULT_MAX_METADATA_BYTES;
  const sessionsByCliId = new Map();
  const ambiguousCliIds = new Set();
  if (!metadataRoot) return sessionsByCliId;

  let fileCount = 0;
  outer:
  for (const organization of listSafeDirectories(fsImpl, metadataRoot)) {
    const organizationPath = path.join(metadataRoot, organization.name);
    for (const account of listSafeDirectories(fsImpl, organizationPath)) {
      const accountPath = path.join(organizationPath, account.name);
      let files;
      try {
        files = fsImpl.readdirSync(accountPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /^local_[0-9a-f-]+\.json$/i.test(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (_err) {
        continue;
      }

      for (const file of files) {
        if (fileCount >= maxFiles) break outer;
        fileCount += 1;
        const expectedLocalSessionId = file.name.slice(0, -".json".length);
        if (!LOCAL_SESSION_ID_RE.test(expectedLocalSessionId)) continue;
        const identity = readMetadataIdentity(
          fsImpl,
          path.join(accountPath, file.name),
          expectedLocalSessionId,
          maxMetadataBytes,
        );
        if (!identity || ambiguousCliIds.has(identity.cliSessionId)) continue;

        const existing = sessionsByCliId.get(identity.cliSessionId);
        if (existing && existing.toLowerCase() !== identity.localSessionId.toLowerCase()) {
          sessionsByCliId.delete(identity.cliSessionId);
          ambiguousCliIds.add(identity.cliSessionId);
          continue;
        }
        sessionsByCliId.set(identity.cliSessionId, identity.localSessionId);
      }
    }
  }

  return sessionsByCliId;
}

function createClaudeDesktopSessionResolver(options = {}) {
  const metadataRoot = Object.prototype.hasOwnProperty.call(options, "metadataRoot")
    ? normalizeString(options.metadataRoot)
    : getDefaultClaudeDesktopMetadataRoot(options);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs >= 0
    ? options.cacheTtlMs
    : DEFAULT_CACHE_TTL_MS;
  let expiresAt = 0;
  let sessionsByCliId = new Map();

  function refresh() {
    sessionsByCliId = scanClaudeDesktopSessionMetadata({
      fsImpl: options.fsImpl,
      metadataRoot,
      maxFiles: options.maxFiles,
      maxMetadataBytes: options.maxMetadataBytes,
    });
    expiresAt = now() + cacheTtlMs;
  }

  function resolveClaudeDesktopSession(entry) {
    const cliSessionId = getClaudeCliSessionId(entry);
    if (!cliSessionId || !metadataRoot) return null;
    if (now() >= expiresAt) refresh();
    const localSessionId = sessionsByCliId.get(cliSessionId);
    const url = buildClaudeDesktopSessionUrl(localSessionId);
    return url
      ? { cliSessionId, localSessionId, url }
      : null;
  }

  resolveClaudeDesktopSession.clearCache = () => {
    expiresAt = 0;
    sessionsByCliId = new Map();
  };
  return resolveClaudeDesktopSession;
}

function sanitizeFocusError(err) {
  return err && err.message ? err.message.replace(/[\r\n\t]+/g, " ") : "unknown";
}

function focusClaudeDesktopSessionTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  resolveClaudeDesktopSession,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  const cliSessionId = getClaudeCliSessionId(focusEntry);
  if (!cliSessionId || !shell || typeof shell.openExternal !== "function") return null;

  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  let target = null;
  try {
    target = typeof resolveClaudeDesktopSession === "function"
      ? resolveClaudeDesktopSession(focusEntry)
      : null;
  } catch (err) {
    focusLog(`focus result branch=claude-desktop-session reason=metadata-error source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
    return null;
  }
  if (!target || !target.url) {
    focusLog(`focus result branch=claude-desktop-session reason=metadata-not-found source=${requestSource} sid=${id}`);
    return null;
  }

  focusLog(`focus request source=${requestSource} sid=${id} agent=claude-code target=claude-desktop-session`);
  const handleOpenFailure = (err) => {
    focusLog(`focus result branch=claude-desktop-session reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
    if (!focusTerminalSession(focusEntry, id, requestSource)) {
      focusLog(`focus result branch=none reason=claude-desktop-session-fallback-unavailable source=${requestSource} sid=${id}`);
    }
  };

  try {
    return Promise.resolve(shell.openExternal(target.url))
      .then(() => {
        focusLog(`focus result branch=claude-desktop-session reason=opened source=${requestSource} sid=${id}`);
      })
      .catch(handleOpenFailure);
  } catch (err) {
    handleOpenFailure(err);
    return Promise.resolve();
  }
}

module.exports = {
  buildClaudeDesktopSessionUrl,
  createClaudeDesktopSessionResolver,
  focusClaudeDesktopSessionTarget,
  getClaudeCliSessionId,
  getDefaultClaudeDesktopMetadataRoot,
  scanClaudeDesktopSessionMetadata,
};
