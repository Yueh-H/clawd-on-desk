#!/usr/bin/env node
// Clawd - Grok CLI native lifecycle hook (state-only, fail-open).

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  applyWslSourceFields,
  postStateToRunningServer,
  readHostPrefix,
} = require("./server-config");
const { fitStateBodyToByteBudget } = require("./state-payload-size");
const {
  applyOrcaPaneKey,
  createPidResolver,
  getPlatformConfig,
  processAlive,
  readStdinJsonDetailed,
} = require("./shared-process");

const STDIN_READ_TIMEOUT_MS = 400;
const SESSION_METADATA_MAX_BYTES = 256 * 1024;
const ACTIVE_SESSIONS_MAX_BYTES = 256 * 1024;
const SESSION_TITLE_MAX = 80;
const OPAQUE_ID_MAX = 256;
const NO_DECISION_OUTPUT = "{}";

const EVENT_ALIASES = Object.freeze({
  session_start: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  post_tool_use_failure: "PostToolUseFailure",
  permission_denied: "PermissionDenied",
  stop: "Stop",
  stop_failure: "StopFailure",
  stop_cancelled: "StopCancelled",
  notification: "Notification",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  session_end: "SessionEnd",
});

const EVENT_TO_STATE = Object.freeze({
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  PermissionDenied: "notification",
  Stop: "attention",
  StopFailure: "error",
  StopCancelled: "attention",
  Notification: "notification",
  PreCompact: "sweeping",
  PostCompact: "thinking",
  SessionEnd: "sleeping",
});

const EVENT_TO_LIFECYCLE = Object.freeze({
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
});
const METADATA_REFRESH_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
]);

function normalizeOpaqueId(value, maxLength = OPAQUE_ID_MAX) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) return null;
  return text;
}

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^<[^>]+>$/.test(text)) return null;
  return text.length > SESSION_TITLE_MAX
    ? `${text.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : text;
}

function resolveGrokEvent(payload, argvEvent) {
  const explicit = normalizeOpaqueId(argvEvent, 64);
  if (explicit && EVENT_TO_STATE[explicit]) return explicit;
  const wire = payload && normalizeOpaqueId(payload.hookEventName, 64);
  if (!wire) return null;
  if (EVENT_TO_STATE[wire]) return wire;
  return EVENT_ALIASES[wire] || null;
}

function rawGrokSessionId(payload, env = process.env) {
  return normalizeOpaqueId(env && env.GROK_SESSION_ID)
    || normalizeOpaqueId(payload && payload.sessionId);
}

function normalizeGrokSessionId(value) {
  const raw = normalizeOpaqueId(value);
  if (!raw) return null;
  return raw.startsWith("grok:") ? raw : `grok:${raw}`;
}

function grokSessionSummaryPath(cwd, rawSessionId, options = {}) {
  const workspace = normalizeOpaqueId(cwd, 4096);
  const sessionId = normalizeOpaqueId(rawSessionId);
  if (!workspace || !sessionId || !/^[A-Za-z0-9._:-]+$/.test(sessionId)) return null;
  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, ".grok", "sessions", encodeURIComponent(workspace), sessionId, "summary.json");
}

function readGrokSessionMetadata(cwd, rawSessionId, options = {}) {
  const summaryPath = grokSessionSummaryPath(cwd, rawSessionId, options);
  if (!summaryPath) return {};
  const fsImpl = options.fs || fs;
  try {
    const stat = fsImpl.statSync(summaryPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > SESSION_METADATA_MAX_BYTES) return {};
    const parsed = JSON.parse(fsImpl.readFileSync(summaryPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const sessionTitle = normalizeTitle(parsed.generated_title);
    const model = normalizeOpaqueId(parsed.current_model_id, 128);
    return {
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(model ? { model } : {}),
    };
  } catch {
    return {};
  }
}

function readGrokActiveSessionPid(rawSessionId, cwd, options = {}) {
  const sessionId = normalizeOpaqueId(rawSessionId);
  const workspace = normalizeOpaqueId(cwd, 4096);
  if (!sessionId) return null;
  const fsImpl = options.fs || fs;
  const homeDir = options.homeDir || os.homedir();
  const activeSessionsPath = options.activeSessionsPath
    || path.join(homeDir, ".grok", "active_sessions.json");
  try {
    const stat = fsImpl.statSync(activeSessionsPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > ACTIVE_SESSIONS_MAX_BYTES) return null;
    const parsed = JSON.parse(fsImpl.readFileSync(activeSessionsPath, "utf8"));
    if (!Array.isArray(parsed) || parsed.length > 1024) return null;
    const matches = parsed.filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      if (normalizeOpaqueId(entry.session_id) !== sessionId) return false;
      const entryCwd = normalizeOpaqueId(entry.cwd, 4096);
      return !workspace || entryCwd === workspace;
    });
    if (matches.length !== 1) return null;
    const pid = Number(matches[0].pid);
    if (!Number.isInteger(pid) || pid <= 1 || !processAlive(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function isSubagentPayload(payload) {
  return !!normalizeOpaqueId(payload && payload.subagentType, 128);
}

function notificationState(payload) {
  const kind = normalizeOpaqueId(payload && payload.notificationType, 64);
  if (kind === "idle_prompt" || kind === "task_complete") return "attention";
  return "notification";
}

function stateForGrokEvent(event, payload) {
  if (!EVENT_TO_STATE[event] || isSubagentPayload(payload)) return null;
  if (event === "Stop") {
    const reason = normalizeOpaqueId(payload && payload.reason, 64);
    if (reason && reason !== "end_turn") return null;
    // A third-party Stop gate may keep this turn running. Grok cannot tell an
    // observer whether a stopHookActive fire is the final continuation, so let
    // idle_prompt be the authoritative settlement instead of flashing idle.
    if (payload && payload.stopHookActive === true) return null;
  }
  return event === "Notification" ? notificationState(payload) : EVENT_TO_STATE[event];
}

function isGrokAgentCommandLine(commandLine) {
  if (typeof commandLine !== "string") return false;
  const text = commandLine.toLowerCase().replace(/\\/g, "/");
  return /(^|[\s"'/])grok(?:\.exe)?($|[\s"'/])/.test(text)
    || text.includes("/bin/grok")
    || text.includes("@xai-org/grok");
}

function applyLocalProcessFields(body, resolve, rawSessionId, event) {
  const resolved = resolve({
    namespace: "grok",
    sessionId: body.session_id,
    cacheCwd: body.cwd || "",
    lifecycle: EVENT_TO_LIFECYCLE[event] || "event",
    cacheable: !!rawSessionId && rawSessionId !== "default" && !!body.cwd,
  });
  const agentPid = Number.isFinite(resolved.agentPid) && resolved.agentPid > 1
    ? Math.floor(resolved.agentPid)
    : null;
  // An active_sessions.json PID is only a starting hint. The shared walk must
  // independently rediscover a Grok process before any focus metadata is
  // trusted; otherwise a stale or edited file could point Clawd at an unrelated
  // terminal window.
  if (agentPid) {
    body.agent_pid = agentPid;
    if (Number.isFinite(resolved.stablePid) && resolved.stablePid > 1) {
      body.source_pid = Math.floor(resolved.stablePid);
    }
    if (resolved.detectedEditor) body.editor = resolved.detectedEditor;
    if (Array.isArray(resolved.pidChain) && resolved.pidChain.length) body.pid_chain = resolved.pidChain;
    if (resolved.tmuxSocket) body.tmux_socket = resolved.tmuxSocket;
    if (resolved.tmuxClient) body.tmux_client = resolved.tmuxClient;
  }
  applyOrcaPaneKey(body);
}

function resolveCwd(payload, env = process.env) {
  return normalizeOpaqueId(payload && payload.cwd, 4096)
    || normalizeOpaqueId(payload && payload.workspaceRoot, 4096)
    || normalizeOpaqueId(env && env.GROK_WORKSPACE_ROOT, 4096)
    || "";
}

function buildStateBody(event, payload, resolve, options = {}) {
  const state = stateForGrokEvent(event, payload || {});
  if (!state) return null;
  const env = options.env || process.env;
  const rawSessionId = rawGrokSessionId(payload, env);
  const sessionId = normalizeGrokSessionId(rawSessionId);
  if (!sessionId) return null;

  const cwd = resolveCwd(payload, env);
  // summary.json is small, but tool hooks are hot-path and run in a fresh
  // process. Refresh title/model only at turn boundaries instead of doing a
  // synchronous disk read for every Pre/PostToolUse event.
  const metadata = METADATA_REFRESH_EVENTS.has(event)
    ? readGrokSessionMetadata(cwd, rawSessionId, options)
    : {};
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "grok",
    hook_source: "grok-native",
  };
  if (cwd) body.cwd = cwd;
  if (metadata.sessionTitle) body.session_title = metadata.sessionTitle;
  const model = normalizeOpaqueId(payload && payload.model, 128) || metadata.model;
  if (model) body.model = model;
  const permissionMode = normalizeOpaqueId(payload && payload.permissionMode, 64);
  if (permissionMode) body.permission_mode = permissionMode;
  if (event === "Notification") {
    const notificationType = normalizeOpaqueId(payload && payload.notificationType, 64);
    if (notificationType) body.grok_notification_type = notificationType;
  }
  const promptId = normalizeOpaqueId(payload && payload.promptId);
  if (promptId) body.grok_prompt_id = promptId;
  const toolName = normalizeOpaqueId(payload && payload.toolName, 256);
  if (toolName) body.tool_name = toolName;
  const toolUseId = normalizeOpaqueId(payload && payload.toolUseId);
  if (toolUseId) body.tool_use_id = toolUseId;
  if (event === "SessionStart") {
    const source = normalizeOpaqueId(payload && payload.source, 64);
    if (source) body.session_start_source = source;
  }
  if (event === "Stop") {
    const backgroundCount = Array.isArray(payload.backgroundTasks) ? payload.backgroundTasks.length : 0;
    const cronCount = Array.isArray(payload.sessionCrons) ? payload.sessionCrons.length : 0;
    if (backgroundCount > 0) body.background_tasks_count = backgroundCount;
    if (cronCount > 0) body.session_crons_count = cronCount;
    if (payload.stopHookActive === true) body.stop_hook_active = true;
  }

  if (options.remote) {
    body.host = options.host || readHostPrefix();
    applyWslSourceFields(body, { remote: true });
    applyOrcaPaneKey(body, env);
  } else {
    applyWslSourceFields(body);
    applyLocalProcessFields(body, resolve, rawSessionId, event);
  }
  return body;
}

async function run(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const event = resolveGrokEvent(payload, argvEvent);
  if (!event) return { event: null, body: null, posted: false, stdout: NO_DECISION_OUTPUT };
  const remote = env.CLAWD_REMOTE === "1";
  const body = buildStateBody(event, payload || {}, deps.resolvePid || (() => ({})), {
    env,
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    homeDir: deps.homeDir,
    fs: deps.fs,
  });
  if (!body) return { event, body: null, posted: false, stdout: NO_DECISION_OUTPUT };

  const completion = event === "Stop" || event === "StopFailure" || event === "StopCancelled";
  const fitted = fitStateBodyToByteBudget(body);
  return new Promise((resolveRun) => {
    const postState = deps.postState || postStateToRunningServer;
    postState(JSON.stringify(fitted.body), { timeoutMs: completion ? 1000 : 100 }, (posted, port) => {
      resolveRun({
        event,
        body,
        posted: posted === true,
        port: port || null,
        stdout: NO_DECISION_OUTPUT,
      });
    });
  });
}

async function main(argvEvent = process.argv[2], deps = {}) {
  try {
    const stdinRead = deps.payload !== undefined
      ? { payload: deps.payload }
      : await (deps.readStdin || readStdinJsonDetailed)({ timeoutMs: STDIN_READ_TIMEOUT_MS });
    const payload = (stdinRead && stdinRead.payload) || {};
    const env = deps.env || process.env;
    const activeSessionPid = readGrokActiveSessionPid(
      rawGrokSessionId(payload, env),
      resolveCwd(payload, env),
      { homeDir: deps.homeDir, fs: deps.fs, activeSessionsPath: deps.activeSessionsPath },
    );
    const config = getPlatformConfig();
    const resolvePid = deps.resolvePid || createPidResolver({
      agentNames: {
        win: new Set(["grok.exe"]),
        mac: new Set(["grok"]),
        linux: new Set(["grok"]),
      },
      agentCmdlineCheck: isGrokAgentCommandLine,
      platformConfig: config,
      ...(activeSessionPid ? { startPid: activeSessionPid } : {}),
    });
    const result = await run(payload, argvEvent, {
      ...deps,
      resolvePid,
      readHostPrefix: deps.readHostPrefix || readHostPrefix,
    });
    process.stdout.write(`${result.stdout}\n`);
    return result;
  } catch {
    process.stdout.write(`${NO_DECISION_OUTPUT}\n`);
    return { event: null, body: null, posted: false, stdout: NO_DECISION_OUTPUT };
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), () => {
    process.stdout.write(`${NO_DECISION_OUTPUT}\n`);
    process.exit(0);
  });
}

module.exports = {
  EVENT_TO_STATE,
  NO_DECISION_OUTPUT,
  STDIN_READ_TIMEOUT_MS,
  buildStateBody,
  grokSessionSummaryPath,
  isGrokAgentCommandLine,
  isSubagentPayload,
  main,
  normalizeGrokSessionId,
  normalizeOpaqueId,
  normalizeTitle,
  rawGrokSessionId,
  readGrokActiveSessionPid,
  readGrokSessionMetadata,
  resolveGrokEvent,
  run,
  stateForGrokEvent,
};
