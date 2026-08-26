#!/usr/bin/env node
// Install Clawd's state-only Grok hook as an owned ~/.grok/hooks/*.json file.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { resolveNodeBin } = require("./server-config");
const {
  asarUnpackedPath,
  commandMatchesMarker,
  createBackup,
  extractExistingNodeBin,
  formatNodeHookCommand,
  pruneOldBackups,
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
} = require("./json-utils");

const MARKER = "grok-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".grok");
const DEFAULT_HOOKS_DIR = path.join(DEFAULT_PARENT_DIR, "hooks");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_HOOKS_DIR, "clawd-on-desk.json");
const GROK_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
]);
const GROK_NOTIFICATION_MATCHER = "^(idle_prompt|permission_prompt|task_complete)$";
const GROK_HOOK_TIMEOUT_SECONDS = 5;

function resolveGrokParentDir(options = {}) {
  return options.parentDir || path.join(options.homeDir || os.homedir(), ".grok");
}

function resolveGrokConfigPath(options = {}) {
  return options.configPath
    || path.join(resolveGrokParentDir(options), "hooks", "clawd-on-desk.json");
}

function buildGrokHookCommand(nodeBin, hookScript, event, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
    windowsWrapper: "encoded",
  });
}

function buildGrokHookEntry(command, event) {
  const entry = {
    hooks: [{
      type: "command",
      command,
      timeout: GROK_HOOK_TIMEOUT_SECONDS,
    }],
  };
  if (event === "Notification") entry.matcher = GROK_NOTIFICATION_MATCHER;
  return entry;
}

function buildGrokHookConfig(nodeBin, hookScript, options = {}) {
  const hooks = {};
  for (const event of GROK_HOOK_EVENTS) {
    const command = buildGrokHookCommand(nodeBin, hookScript, event, options);
    hooks[event] = [buildGrokHookEntry(command, event)];
  }
  return { hooks };
}

function containsManagedMarker(value) {
  if (typeof value === "string") return commandMatchesMarker(value, MARKER);
  if (Array.isArray(value)) return value.some(containsManagedMarker);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsManagedMarker);
}

function readExistingConfig(configPath) {
  try {
    return readJsonFile(configPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new Error(`Failed to read Grok hook config: ${err.message}`);
  }
}

function registerGrokHooks(options = {}) {
  const parentDir = resolveGrokParentDir(options);
  const configPath = resolveGrokConfigPath(options);
  const explicitPath = Boolean(options.configPath || options.parentDir);
  if (!explicitPath && !fs.existsSync(parentDir)) {
    if (!options.silent) console.log("Clawd: ~/.grok/ not found - skipping Grok hook registration");
    return {
      installed: false,
      reason: "grok-not-installed",
      added: 0,
      updated: 0,
      skipped: 0,
      configPath,
    };
  }

  const existing = readExistingConfig(configPath);
  if (existing && !containsManagedMarker(existing)) {
    throw new Error(`Refusing to overwrite non-Clawd Grok hook file: ${configPath}`);
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));
  const resolvedNode = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin(options);
  const nodeBin = resolvedNode
    || (existing ? extractExistingNodeBin(existing, MARKER, { nested: true }) : null)
    || "node";
  const desired = buildGrokHookConfig(nodeBin, hookScript, {
    platform: options.platform || process.platform,
  });

  if (existing && isDeepStrictEqual(existing, desired)) {
    if (!options.silent) console.log(`Clawd Grok hooks already current: ${configPath}`);
    return {
      installed: true,
      added: 0,
      updated: 0,
      skipped: GROK_HOOK_EVENTS.length,
      configPath,
    };
  }

  let backupPath = null;
  if (existing) backupPath = writeJsonAtomicWithBackup(configPath, desired, options);
  else writeJsonAtomic(configPath, desired);
  if (!options.silent) console.log(`Clawd Grok hooks -> ${configPath}`);
  const result = {
    installed: true,
    added: existing ? 0 : GROK_HOOK_EVENTS.length,
    updated: existing ? GROK_HOOK_EVENTS.length : 0,
    skipped: 0,
    configPath,
  };
  if (backupPath) result.backupPath = backupPath;
  return result;
}

function unregisterGrokHooks(options = {}) {
  const configPath = resolveGrokConfigPath(options);
  const existing = readExistingConfig(configPath);
  if (!existing) return { removed: 0, changed: false, configPath };
  if (!containsManagedMarker(existing)) {
    return {
      removed: 0,
      changed: false,
      configPath,
      warnings: [`Preserved non-Clawd Grok hook file: ${configPath}`],
    };
  }

  const backupPath = createBackup(configPath, options);
  fs.unlinkSync(configPath);
  if (backupPath) pruneOldBackups(configPath, options, backupPath);
  if (!options.silent) console.log(`Clawd Grok hooks removed: ${GROK_HOOK_EVENTS.length}`);
  const result = {
    removed: GROK_HOOK_EVENTS.length,
    changed: true,
    configPath,
  };
  if (backupPath) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_HOOKS_DIR,
  DEFAULT_PARENT_DIR,
  GROK_HOOK_EVENTS,
  GROK_HOOK_TIMEOUT_SECONDS,
  GROK_NOTIFICATION_MATCHER,
  MARKER,
  buildGrokHookCommand,
  buildGrokHookConfig,
  buildGrokHookEntry,
  containsManagedMarker,
  registerGrokHooks,
  resolveGrokConfigPath,
  unregisterGrokHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterGrokHooks({ backup: true });
    else registerGrokHooks({});
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  }
}
