"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  buildTerminalCandidates,
  launchClaudeSession,
  normalizeClaudeSessionId,
  tryLaunch,
} = require("./launch-claude");
const { getCodexThreadUrl } = require("./session-focus");
const { parseSessionKey } = require("./session-key");
const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_HISTORY_LOCATOR_RE = /^codex:[a-zA-Z0-9-]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CODEX_SESSION_META_READ_MAX_BYTES = 64 * 1024;
const CODEX_HISTORY_SCAN_MAX_ENTRIES = 50000;
const SUPPORTED_RESUME_COMMANDS = new Set(["agy", "codex", "opencode"]);
const execFileAsync = promisify(execFile);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function rawSessionIdCandidates(entry) {
  const values = [];
  for (const value of [entry && entry.rawSessionId, entry && entry.id]) {
    const sessionId = normalizeString(value);
    if (!sessionId) continue;
    const identity = parseSessionKey(sessionId);
    const rawSessionId = identity ? identity.rawSessionId : sessionId;
    if (rawSessionId && !values.includes(rawSessionId)) values.push(rawSessionId);
  }
  return values;
}

function prefixedUuid(entry, prefix) {
  const pattern = new RegExp(`^(?:${prefix}:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, "i");
  for (const value of rawSessionIdCandidates(entry)) {
    const match = value.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function claudeSessionId(entry) {
  for (const value of rawSessionIdCandidates(entry)) {
    try {
      const normalized = normalizeClaudeSessionId(value);
      if (normalized) return normalized;
    } catch {}
  }
  return null;
}

function codexHistoryLocator(entry) {
  for (const value of rawSessionIdCandidates(entry)) {
    const match = value.match(CODEX_HISTORY_LOCATOR_RE);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function opencodeSessionId(entry) {
  for (const value of rawSessionIdCandidates(entry)) {
    const match = value.match(/^(?:opencode:)?(ses_[a-zA-Z0-9_-]{1,192})$/);
    if (match) return match[1];
  }
  return null;
}

function getRetainedSessionResumeTarget(entry, options = {}) {
  if (!entry || entry.manualRetained !== true) {
    return { canResume: false, type: null, reason: "not-retained" };
  }
  if (entry.headless || entry.host || entry.platform === "webui") {
    return { canResume: false, type: null, reason: "unsupported-surface" };
  }

  const osPlatform = normalizeString(options.osPlatform || process.platform).toLowerCase();
  if (entry.agentId === "codex") {
    const sessionId = prefixedUuid(entry, "codex");
    if (sessionId) {
      const url = getCodexThreadUrl(entry);
      if (url && osPlatform !== "win32") {
        return { canResume: true, type: "codex-thread", sessionId, url };
      }
      return { canResume: true, type: "codex-cli", sessionId, url: null };
    }
    const locatorId = codexHistoryLocator(entry);
    if (locatorId && isCodexDesktopOriginator(entry.codexOriginator || entry.originator)) {
      return { canResume: true, type: "codex-history", sessionId: locatorId, url: null };
    }
    return { canResume: false, type: null, reason: "invalid-session-id" };
  }

  if (entry.agentId === "claude-code") {
    const sessionId = claudeSessionId(entry);
    return sessionId
      ? { canResume: true, type: "claude-cli", sessionId, url: null }
      : { canResume: false, type: null, reason: "invalid-session-id" };
  }

  if (entry.agentId === "antigravity-cli") {
    const sessionId = prefixedUuid(entry, "antigravity");
    if (!sessionId) return { canResume: false, type: null, reason: "invalid-session-id" };
    const surface = entry.antigravitySurface === "desktop" || entry.antigravitySurface === "cli"
      ? entry.antigravitySurface
      : "auto";
    return { canResume: true, type: `antigravity-${surface}`, sessionId, url: null };
  }

  if (entry.agentId === "opencode") {
    const sessionId = opencodeSessionId(entry);
    return sessionId
      ? { canResume: true, type: "opencode-cli", sessionId, url: null }
      : { canResume: false, type: null, reason: "invalid-session-id" };
  }

  return { canResume: false, type: null, reason: "unsupported-agent" };
}

function directoryExists(dir, options = {}) {
  const statSync = options.statSync || fs.statSync;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function resolveResumeCwd(entry, options = {}) {
  const cwd = normalizeString(entry && entry.cwd);
  return cwd && directoryExists(cwd, options) ? cwd : null;
}

function detectAntigravitySurface(sessionId, options = {}) {
  if (!UUID_RE.test(normalizeString(sessionId))) {
    return { surface: "unknown", desktopAvailable: false, cliAvailable: false };
  }
  const homeDir = normalizeString(options.homeDir) || os.homedir();
  const desktopAvailable = directoryExists(
    path.join(homeDir, ".gemini", "antigravity", "brain", sessionId),
    options
  );
  const cliAvailable = directoryExists(
    path.join(homeDir, ".gemini", "antigravity-cli", "brain", sessionId),
    options
  );
  return {
    surface: desktopAvailable ? "desktop" : (cliAvailable ? "cli" : "unknown"),
    desktopAvailable,
    cliAvailable,
  };
}

function readCodexSessionMetaId(filePath, options = {}) {
  const openSync = options.openSync || fs.openSync;
  const readSync = options.readSync || fs.readSync;
  const closeSync = options.closeSync || fs.closeSync;
  const fstatSync = options.fstatSync || fs.fstatSync;
  let fd;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    const length = Math.min(Number(stat.size) || 0, CODEX_SESSION_META_READ_MAX_BYTES);
    if (length <= 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    const record = JSON.parse(firstLine);
    const id = normalizeString(record && record.type === "session_meta" && record.payload && record.payload.id);
    return UUID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function resolveCodexThreadIdFromHistory(_entry, locatorId, options = {}) {
  const normalizedLocator = normalizeString(locatorId).toLowerCase();
  if (!UUID_RE.test(normalizedLocator)) return null;
  const codexDir = normalizeString(options.codexDir || process.env.CODEX_HOME)
    || path.join(normalizeString(options.homeDir) || os.homedir(), ".codex");
  const sessionsRoot = path.join(codexDir, "sessions");
  const readdirSync = options.readdirSync || fs.readdirSync;
  const stack = [sessionsRoot];
  const threadIds = new Set();
  let visited = 0;

  while (stack.length && visited < CODEX_HISTORY_SCAN_MAX_ENTRIES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of entries) {
      visited += 1;
      if (visited > CODEX_HISTORY_SCAN_MAX_ENTRIES) break;
      const itemPath = path.join(dir, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) {
        stack.push(itemPath);
      } else if (
        item.isFile()
        && item.name.endsWith(`_${normalizedLocator}.jsonl`)
      ) {
        const threadId = readCodexSessionMetaId(itemPath, options);
        if (threadId) threadIds.add(threadId);
      }
    }
  }

  return threadIds.size === 1 ? [...threadIds][0] : null;
}

function commonExecutableCandidates(command, osPlatform, options = {}) {
  const homeDir = normalizeString(options.homeDir) || os.homedir();
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  if (osPlatform === "win32") {
    return [
      path.join(env.APPDATA || "", "npm", `${command}.cmd`),
      path.join(env.LOCALAPPDATA || "", "npm", `${command}.cmd`),
    ];
  }
  return [
    path.join(homeDir, ".local", "bin", command),
    path.join(homeDir, ".npm-global", "bin", command),
    path.join("/opt/homebrew/bin", command),
    path.join("/usr/local/bin", command),
  ];
}

async function findResumeExecutable(command, options = {}) {
  if (!SUPPORTED_RESUME_COMMANDS.has(command)) return null;
  const osPlatform = normalizeString(options.osPlatform || process.platform).toLowerCase();
  const existsSync = options.existsSync || fs.existsSync;
  const runExecFile = options.execFileAsync || execFileAsync;
  try {
    const lookup = osPlatform === "win32" ? "where" : "which";
    const { stdout } = await runExecFile(lookup, [command], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const paths = String(stdout || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value && existsSync(value));
    if (osPlatform === "win32") {
      const launchable = paths.find((value) => /\.(com|exe|bat|cmd)$/i.test(value));
      if (launchable) return launchable;
    } else if (paths.length) {
      return paths[0];
    }
  } catch {}

  return commonExecutableCandidates(command, osPlatform, options).find((value) => value && existsSync(value)) || null;
}

async function launchResumeCommand(command, args, entry, options = {}) {
  const cwd = resolveResumeCwd(entry, options);
  if (!cwd) return { status: "error", reason: "working-directory-unavailable" };
  const osPlatform = normalizeString(options.osPlatform || process.platform).toLowerCase();
  const findExecutable = options.findResumeExecutable || findResumeExecutable;
  const executable = await findExecutable(command, options);
  if (!executable) return { status: "error", reason: "agent-cli-unavailable" };

  const candidates = buildTerminalCandidates(executable, args, osPlatform, cwd);
  const launch = options.tryLaunch || tryLaunch;
  let lastError = null;
  for (const candidate of candidates) {
    const result = await launch(candidate.bin, candidate.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd,
      ...(candidate.extraOpts || {}),
    });
    if (result && result.ok) {
      return { status: "ok", action: "launch-terminal", terminal: candidate.bin };
    }
    lastError = result && result.error;
  }
  return {
    status: "error",
    reason: "terminal-launch-failed",
    message: lastError && lastError.message ? lastError.message : undefined,
  };
}

async function resumeRetainedSession(entry, options = {}) {
  const target = getRetainedSessionResumeTarget(entry, options);
  if (!target.canResume) return { status: "unavailable", reason: target.reason };

  try {
    if (target.type === "codex-thread") {
      if (typeof options.openCodexThread !== "function") {
        return { status: "error", reason: "codex-app-unavailable" };
      }
      const opened = await options.openCodexThread(target.url, entry);
      return opened === false
        ? { status: "error", reason: "codex-app-unavailable" }
        : { status: "ok", action: "open-codex-thread" };
    }

    if (target.type === "codex-history") {
      const resolveThreadId = options.resolveCodexThreadIdFromHistory || resolveCodexThreadIdFromHistory;
      const threadId = await resolveThreadId(entry, target.sessionId, options);
      if (!threadId) return { status: "error", reason: "codex-thread-unavailable" };
      if (normalizeString(options.osPlatform || process.platform).toLowerCase() === "win32") {
        return launchResumeCommand("codex", ["resume", threadId], entry, options);
      }
      if (typeof options.openCodexThread !== "function") {
        return { status: "error", reason: "codex-app-unavailable" };
      }
      const opened = await options.openCodexThread(`codex://threads/${threadId}`, entry);
      return opened === false
        ? { status: "error", reason: "codex-app-unavailable" }
        : { status: "ok", action: "open-codex-thread" };
    }

    if (target.type === "claude-cli") {
      const cwd = resolveResumeCwd(entry, options);
      if (!cwd) return { status: "error", reason: "working-directory-unavailable" };
      const launchClaude = options.launchClaudeSession || launchClaudeSession;
      const result = await launchClaude("resume", cwd, target.sessionId);
      return result && result.ok
        ? { status: "ok", action: "launch-terminal", terminal: result.terminal }
        : { status: "error", reason: "terminal-launch-failed" };
    }

    if (target.type === "codex-cli") {
      return launchResumeCommand("codex", ["resume", target.sessionId], entry, options);
    }

    if (target.type === "opencode-cli") {
      return launchResumeCommand("opencode", ["--session", target.sessionId], entry, options);
    }

    if (target.type.startsWith("antigravity-")) {
      const detected = detectAntigravitySurface(target.sessionId, options);
      const wantsDesktop = target.type === "antigravity-desktop"
        || (target.type === "antigravity-auto" && detected.surface !== "cli");
      if (wantsDesktop && typeof options.navigateAntigravityConversation === "function") {
        try {
          await options.navigateAntigravityConversation(target.sessionId);
          return { status: "ok", action: "open-antigravity-conversation" };
        } catch (_err) {
          if (target.type === "antigravity-desktop" || !detected.cliAvailable) {
            return { status: "error", reason: "antigravity-app-unavailable" };
          }
        }
      }
      if (target.type === "antigravity-cli" || detected.cliAvailable) {
        return launchResumeCommand("agy", ["--conversation", target.sessionId], entry, options);
      }
      return { status: "error", reason: "antigravity-app-unavailable" };
    }
  } catch (_err) {
    return { status: "error", reason: "resume-failed" };
  }

  return { status: "unavailable", reason: "unsupported-agent" };
}

module.exports = {
  detectAntigravitySurface,
  findResumeExecutable,
  getRetainedSessionResumeTarget,
  launchResumeCommand,
  resolveResumeCwd,
  resolveCodexThreadIdFromHistory,
  resumeRetainedSession,
};
