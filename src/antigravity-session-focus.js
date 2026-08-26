"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { parseSessionKey } = require("./session-key");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_SESSION_ID_RE = /^antigravity:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 2500;
const DEFAULT_MAX_TARGETS_BYTES = 512 * 1024;
const MAX_DEVTOOLS_ACTIVE_PORT_BYTES = 4096;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function makeFocusError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function getAntigravitySurface(entry) {
  const transcriptPath = normalizeString(entry && entry.transcriptPath).replace(/\\/g, "/").toLowerCase();
  if (transcriptPath.includes("/.gemini/antigravity-cli/brain/")) return "cli";
  if (transcriptPath.includes("/.gemini/antigravity/brain/")) return "desktop";
  return null;
}

function isAntigravityDesktopEntry(entry) {
  const surface = getAntigravitySurface(entry);
  if (surface) return surface === "desktop";

  // Old sessions created before transcript_path was forwarded still need a
  // safe migration path. The desktop hook runs below language_server and never
  // sees an `agy` agent process; a real CLI session does. Once any new event
  // supplies transcriptPath, the explicit surface above takes precedence.
  return !!entry
    && !entry.agentPid
    && Number.isFinite(entry.sourcePid)
    && entry.sourcePid > 0;
}

function getAntigravityConversationId(entry) {
  if (
    !entry
    || entry.agentId !== "antigravity-cli"
    || entry.host
    || entry.platform === "webui"
    || !isAntigravityDesktopEntry(entry)
  ) {
    return null;
  }

  for (const value of [entry.rawSessionId, entry.id]) {
    const sessionId = normalizeString(value);
    if (!sessionId) continue;
    const identity = parseSessionKey(sessionId);
    const rawSessionId = identity ? identity.rawSessionId : sessionId;
    const match = rawSessionId.match(RAW_SESSION_ID_RE);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

function getDefaultAntigravityDevToolsActivePortPath(options = {}) {
  const platform = normalizeString(options.platform || process.platform).toLowerCase();
  const homeDir = normalizeString(options.homeDir) || os.homedir();
  const env = options.env && typeof options.env === "object" ? options.env : process.env;

  if (platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      "Antigravity",
      "DevToolsActivePort",
    );
  }
  if (platform === "win32") {
    const appDataDir = normalizeString(options.appDataDir || env.APPDATA)
      || path.join(homeDir, "AppData", "Roaming");
    return path.join(appDataDir, "Antigravity", "DevToolsActivePort");
  }
  if (platform === "linux") {
    const configDir = normalizeString(options.configDir || env.XDG_CONFIG_HOME)
      || path.join(homeDir, ".config");
    return path.join(configDir, "Antigravity", "DevToolsActivePort");
  }
  return null;
}

function parseDevToolsActivePort(value) {
  const firstLine = String(value || "").split(/\r?\n/, 1)[0].trim();
  if (!/^\d{1,5}$/.test(firstLine)) {
    throw makeFocusError("invalid-devtools-port", "invalid Antigravity DevTools port");
  }
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw makeFocusError("invalid-devtools-port", "invalid Antigravity DevTools port");
  }
  return port;
}

function readDevToolsActivePort(filePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) {
    throw makeFocusError("devtools-port-path-unavailable", "Antigravity DevTools port path unavailable");
  }

  let stat;
  try {
    stat = fsImpl.lstatSync(normalizedPath);
  } catch (_err) {
    throw makeFocusError("devtools-port-file-missing", "Antigravity DevTools port file missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DEVTOOLS_ACTIVE_PORT_BYTES) {
    throw makeFocusError("invalid-devtools-port-file", "invalid Antigravity DevTools port file");
  }

  try {
    return parseDevToolsActivePort(fsImpl.readFileSync(normalizedPath, "utf8"));
  } catch (err) {
    if (err && err.code === "invalid-devtools-port") throw err;
    throw makeFocusError("devtools-port-read-failed", "failed to read Antigravity DevTools port file");
  }
}

function requestAntigravityTargets(port, options = {}) {
  const httpImpl = options.httpImpl || http;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_TARGETS_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const request = httpImpl.request({
      host: "127.0.0.1",
      port,
      path: "/json/list",
      method: "GET",
      headers: { Accept: "application/json" },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(makeFocusError(
          "devtools-targets-http-failed",
          `Antigravity DevTools target request returned ${response.statusCode || 0}`,
        ));
        return;
      }

      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          response.destroy();
          finish(makeFocusError("devtools-targets-too-large", "Antigravity DevTools target list too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        try {
          const targets = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!Array.isArray(targets)) {
            finish(makeFocusError("invalid-devtools-targets", "invalid Antigravity DevTools target list"));
            return;
          }
          finish(null, targets);
        } catch (_err) {
          finish(makeFocusError("invalid-devtools-targets", "invalid Antigravity DevTools target list"));
        }
      });
      response.on("error", (err) => {
        finish(makeFocusError(
          "devtools-targets-response-failed",
          `Antigravity DevTools target response failed: ${normalizeString(err && err.message) || "error"}`,
        ));
      });
    });

    request.on("error", (err) => {
      finish(makeFocusError(
        "devtools-targets-request-failed",
        `Antigravity DevTools target request failed: ${normalizeString(err && err.message) || "error"}`,
      ));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(makeFocusError("devtools-targets-timeout", "Antigravity DevTools target request timed out"));
    });
    request.end();
  });
}

function parseAntigravityPageTarget(target, devToolsPort) {
  if (!target || target.type !== "page") return null;
  const id = normalizeString(target.id);
  const rawPageUrl = normalizeString(target.url);
  const rawWebSocketUrl = normalizeString(target.webSocketDebuggerUrl);
  if (!id || !rawPageUrl || !rawWebSocketUrl) return null;

  let pageUrl;
  let webSocketUrl;
  try {
    pageUrl = new URL(rawPageUrl);
    webSocketUrl = new URL(rawWebSocketUrl);
  } catch (_err) {
    return null;
  }
  if (
    pageUrl.protocol !== "https:"
    || pageUrl.hostname !== "127.0.0.1"
    || !/^\d{1,5}$/.test(pageUrl.port)
    || webSocketUrl.protocol !== "ws:"
    || webSocketUrl.hostname !== "127.0.0.1"
    || Number(webSocketUrl.port) !== devToolsPort
    || webSocketUrl.username
    || webSocketUrl.password
    || !/^\/devtools\/page\/[a-zA-Z0-9_-]+$/.test(webSocketUrl.pathname)
  ) {
    return null;
  }

  return {
    id,
    pageUrl,
    webSocketUrl: webSocketUrl.href,
    title: normalizeString(target.title),
  };
}

function buildAntigravityConversationPath(conversationId) {
  const normalized = normalizeString(conversationId).toLowerCase();
  return UUID_RE.test(normalized) ? `/c/${normalized}` : null;
}

function buildAntigravityConversationUrl(pageUrl, conversationId) {
  const conversationPath = buildAntigravityConversationPath(conversationId);
  if (!conversationPath) return null;

  let targetUrl;
  try {
    targetUrl = pageUrl instanceof URL ? new URL(pageUrl.href) : new URL(String(pageUrl || ""));
  } catch (_err) {
    return null;
  }
  if (
    targetUrl.protocol !== "https:"
    || targetUrl.hostname !== "127.0.0.1"
    || !/^\d{1,5}$/.test(targetUrl.port)
  ) {
    return null;
  }
  targetUrl.pathname = conversationPath;
  targetUrl.search = "";
  targetUrl.hash = "";
  return targetUrl.href;
}

function selectAntigravityPageTarget(targets, devToolsPort, conversationId) {
  const conversationPath = buildAntigravityConversationPath(conversationId);
  if (!conversationPath) {
    throw makeFocusError("invalid-conversation-id", "invalid Antigravity conversation ID");
  }
  const candidates = (Array.isArray(targets) ? targets : [])
    .map((target) => parseAntigravityPageTarget(target, devToolsPort))
    .filter(Boolean);
  const exactMatches = candidates.filter((target) => target.pageUrl.pathname === conversationPath);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1 || candidates.length > 1) {
    throw makeFocusError("ambiguous-devtools-pages", "multiple Antigravity windows are open");
  }
  if (candidates.length === 1) return candidates[0];
  throw makeFocusError("devtools-page-not-found", "Antigravity DevTools page not found");
}

function navigateDevToolsTarget(target, targetUrl, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_NAVIGATION_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let navigationResult = null;
    const socket = new WebSocketImpl(target.webSocketUrl, {
      handshakeTimeout: Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      maxPayload: DEFAULT_MAX_TARGETS_BYTES,
      perMessageDeflate: false,
    });
    const timer = setTimeout(() => {
      finish(makeFocusError("devtools-navigation-timeout", "Antigravity navigation timed out"));
      if (typeof socket.terminate === "function") socket.terminate();
    }, timeoutMs);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof socket.close === "function") {
        try {
          socket.close();
        } catch (_err) {
          // The CDP command has already completed; closing is best effort.
        }
      }
      if (err) reject(err);
      else resolve(value);
    };

    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Page.navigate",
        params: { url: targetUrl },
      }));
    });
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch (_err) {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(makeFocusError(
            "devtools-navigation-failed",
            normalizeString(message.error.message) || "Antigravity navigation failed",
          ));
          return;
        }
        navigationResult = message.result || {};
        socket.send(JSON.stringify({ id: 2, method: "Page.bringToFront" }));
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish(makeFocusError(
            "devtools-bring-to-front-failed",
            normalizeString(message.error.message) || "Antigravity foreground activation failed",
          ));
          return;
        }
        finish(null, {
          targetId: target.id,
          targetUrl,
          frameId: normalizeString(navigationResult && navigationResult.frameId),
        });
      }
    });
    socket.once("error", (err) => {
      finish(makeFocusError(
        "devtools-websocket-failed",
        `Antigravity DevTools WebSocket failed: ${normalizeString(err && err.message) || "error"}`,
      ));
    });
    socket.once("close", () => {
      if (!settled) {
        finish(makeFocusError("devtools-websocket-closed", "Antigravity DevTools WebSocket closed early"));
      }
    });
  });
}

function createAntigravitySessionNavigator(options = {}) {
  const devToolsActivePortPath = Object.prototype.hasOwnProperty.call(options, "devToolsActivePortPath")
    ? normalizeString(options.devToolsActivePortPath)
    : getDefaultAntigravityDevToolsActivePortPath(options);
  const requestTargets = typeof options.requestTargets === "function"
    ? options.requestTargets
    : (port) => requestAntigravityTargets(port, options);
  const navigateTarget = typeof options.navigateTarget === "function"
    ? options.navigateTarget
    : (target, targetUrl) => navigateDevToolsTarget(target, targetUrl, options);

  return async function navigateAntigravityConversation(conversationId) {
    const normalizedConversationId = normalizeString(conversationId).toLowerCase();
    if (!UUID_RE.test(normalizedConversationId)) {
      throw makeFocusError("invalid-conversation-id", "invalid Antigravity conversation ID");
    }
    const port = readDevToolsActivePort(devToolsActivePortPath, options);
    const targets = await requestTargets(port);
    const target = selectAntigravityPageTarget(targets, port, normalizedConversationId);
    const targetUrl = buildAntigravityConversationUrl(target.pageUrl, normalizedConversationId);
    if (!targetUrl) {
      throw makeFocusError("invalid-devtools-page-url", "invalid Antigravity page URL");
    }
    const result = await navigateTarget(target, targetUrl);
    return {
      ...result,
      conversationId: normalizedConversationId,
      targetUrl,
    };
  };
}

function sanitizeFocusError(err) {
  const message = normalizeString(err && err.message).replace(/[\r\n\t]+/g, " ");
  return message || normalizeString(err && err.code) || "unknown";
}

function focusAntigravitySessionTarget({
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  navigateAntigravityConversation,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  const conversationId = getAntigravityConversationId(focusEntry);
  if (!conversationId || typeof navigateAntigravityConversation !== "function") return null;

  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=antigravity-cli target=antigravity-session`);
  const focusSourceApp = (failureReason, logUnavailable = true) => {
    try {
      if (focusTerminalSession(focusEntry, id, requestSource)) return;
    } catch (err) {
      focusLog(`focus result branch=antigravity-session reason=source-focus-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      return;
    }
    if (logUnavailable) {
      focusLog(`focus result branch=none reason=${failureReason} source=${requestSource} sid=${id}`);
    }
  };

  return Promise.resolve()
    .then(() => navigateAntigravityConversation(conversationId))
    .then(() => {
      focusLog(`focus result branch=antigravity-session reason=navigated source=${requestSource} sid=${id}`);
      // Page.bringToFront selects the Electron page. The existing PID-based
      // path additionally restores a minimized native window when available.
      focusSourceApp("antigravity-session-source-focus-unavailable", false);
    })
    .catch((err) => {
      focusLog(`focus result branch=antigravity-session reason=navigation-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      focusSourceApp("antigravity-session-fallback-unavailable");
    });
}

module.exports = {
  buildAntigravityConversationPath,
  buildAntigravityConversationUrl,
  createAntigravitySessionNavigator,
  focusAntigravitySessionTarget,
  getAntigravityConversationId,
  getAntigravitySurface,
  getDefaultAntigravityDevToolsActivePortPath,
  isAntigravityDesktopEntry,
  navigateDevToolsTarget,
  parseAntigravityPageTarget,
  parseDevToolsActivePort,
  readDevToolsActivePort,
  requestAntigravityTargets,
  selectAntigravityPageTarget,
};
