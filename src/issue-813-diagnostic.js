"use strict";

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeChildProcess = require("node:child_process");

const BUILD_LABEL = "issue-813-diagnostic-3";
const DISABLE_GPU_ARG = "--issue813-disable-gpu";
const DEFAULT_CHECK_DELAYS_MS = Object.freeze([0, 5000, 30000]);

function parsePsProcessTable(raw) {
  const entries = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      comm: match[3],
      args: match[4] || "",
    });
  }
  return entries;
}

function isClawdMainProcess(entry) {
  if (!entry || !Number.isInteger(entry.pid)) return false;
  if (/(?:^|\s)--type(?:=|\s)/.test(String(entry.args || ""))) return false;
  const comm = String(entry.comm || "").trim().toLowerCase();
  return comm === "clawd-on-desk" || comm.startsWith("clawd-on-desk-");
}

function collectAncestorPids(entries, currentPid) {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const ancestors = new Set();
  let pid = Number(currentPid);
  for (let depth = 0; Number.isInteger(pid) && pid > 0 && depth < 64; depth += 1) {
    if (ancestors.has(pid)) break;
    ancestors.add(pid);
    const entry = byPid.get(pid);
    if (!entry || !Number.isInteger(entry.ppid) || entry.ppid <= 0) break;
    pid = entry.ppid;
  }
  return ancestors;
}

function normalizeExecutablePath(value, realpathSync = nodeFs.realpathSync) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try { return realpathSync(raw.replace(/ \(deleted\)$/, "")); }
  catch { return ""; }
}

function isCurrentAppImageRuntime(entry, options = {}) {
  const expected = normalizeExecutablePath(options.currentAppImagePath, options.realpathSync);
  if (!expected || !entry || !Number.isInteger(entry.pid)) return false;
  const readlinkSync = options.readlinkSync || nodeFs.readlinkSync;
  let executable;
  try { executable = readlinkSync(`/proc/${entry.pid}/exe`); }
  catch { return false; }
  return normalizeExecutablePath(executable, options.realpathSync) === expected;
}

function inspectExternalClawdProcesses(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") {
    return { ok: true, skipped: true, scanned: 0, conflicts: [], ancestorPids: [] };
  }
  const execFileSync = options.execFileSync || nodeChildProcess.execFileSync;
  const currentPid = Number.isInteger(options.currentPid) ? options.currentPid : process.pid;
  let raw;
  try {
    raw = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      scanned: 0,
      conflicts: [],
      ancestorPids: [],
      error: err && err.message ? err.message : String(err),
    };
  }
  const entries = parsePsProcessTable(raw);
  if (!entries.some((entry) => entry.pid === currentPid)) {
    return {
      ok: false,
      skipped: false,
      scanned: entries.length,
      conflicts: [],
      ancestorPids: [],
      error: `current pid ${currentPid} missing from ps snapshot`,
    };
  }
  const ancestorPids = collectAncestorPids(entries, currentPid);
  const candidates = entries.filter(
    (entry) => isClawdMainProcess(entry) && !ancestorPids.has(entry.pid)
  );
  const ignoredAppImageRuntimes = candidates.filter((entry) => isCurrentAppImageRuntime(entry, {
    currentAppImagePath: options.currentAppImagePath,
    readlinkSync: options.readlinkSync,
    realpathSync: options.realpathSync,
  }));
  const ignoredPids = new Set(ignoredAppImageRuntimes.map((entry) => entry.pid));
  const conflicts = candidates
    .filter((entry) => !ignoredPids.has(entry.pid))
    .map((entry) => ({ pid: entry.pid, ppid: entry.ppid, comm: entry.comm }));
  return {
    ok: true,
    skipped: false,
    scanned: entries.length,
    conflicts,
    ignoredAppImageRuntimes: ignoredAppImageRuntimes
      .map((entry) => ({ pid: entry.pid, ppid: entry.ppid, comm: entry.comm })),
    ancestorPids: [...ancestorPids],
  };
}

function assertNoExternalClawdProcesses(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const result = inspectExternalClawdProcesses(options);
  if (!result.ok) {
    safeLog(log, `Clawd #813 diag3 PROCESS-PREFLIGHT BLOCKED scanError=${result.error || "unknown"}`);
    throw new Error(`Clawd #813 diag3 cannot verify external Clawd processes: ${result.error || "unknown"}`);
  }
  if (result.conflicts.length > 0) {
    const conflicts = result.conflicts.map((entry) => `${entry.pid}:${entry.comm}`).join(",");
    safeLog(log, `Clawd #813 diag3 PROCESS-PREFLIGHT BLOCKED external=${conflicts}`);
    throw new Error(`Clawd #813 diag3 found another Clawd instance (${conflicts}); quit it and retry`);
  }
  if (result.skipped) return result;
  safeLog(
    log,
    `Clawd #813 diag3 PROCESS-PREFLIGHT OK scanned=${result.scanned} `
      + `ancestors=${result.ancestorPids.join(",") || "none"} `
      + `ownAppImageRuntimes=${Array.isArray(result.ignoredAppImageRuntimes) ? result.ignoredAppImageRuntimes.length : 0}`
  );
  return result;
}

function safeLog(log, message) {
  try { log(message); } catch {}
}

function parseOzoneArg(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] == null ? "" : args[index]);
    if (arg === "--ozone-platform") {
      const value = String(args[index + 1] == null ? "" : args[index + 1]);
      return value.startsWith("-") ? "" : value.trim();
    }
    if (arg.startsWith("--ozone-platform=")) {
      return arg.slice("--ozone-platform=".length).trim();
    }
  }
  return "";
}

function configureEarlyRuntime(options = {}) {
  const app = options.app;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const env = options.env || process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  const disableGpu = argv.includes(DISABLE_GPU_ARG);

  const processPreflight = assertNoExternalClawdProcesses({
    platform: options.platform || process.platform,
    currentPid: Number.isInteger(options.currentPid) ? options.currentPid : process.pid,
    execFileSync: options.execFileSync,
    currentAppImagePath: env.APPIMAGE,
    readlinkSync: options.readlinkSync,
    realpathSync: options.realpathSync,
    log,
  });

  if (
    !app
    || typeof app.getPath !== "function"
    || typeof app.setPath !== "function"
  ) {
    throw new Error("Clawd #813 diag3 requires isolated Electron userData support");
  }
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const tempRoot = app.getPath("temp");
  const isolatedUserData = fs.mkdtempSync(path.join(tempRoot, "clawd-on-desk-issue813-diag3-"));
  app.setPath("userData", isolatedUserData);

  if (disableGpu && app && typeof app.disableHardwareAcceleration === "function") {
    app.disableHardwareAcceleration();
  }

  safeLog(
    log,
    `Clawd #813 diag3 START build=${BUILD_LABEL} `
      + `gpuRequest=${disableGpu ? "disable-hardware-acceleration" : "default-policy"} `
      + `session=${String(env.XDG_SESSION_TYPE || "unknown")} `
      + `display=${env.DISPLAY ? "set" : "unset"} `
      + `waylandDisplay=${env.WAYLAND_DISPLAY ? "set" : "unset"} `
      + `envOzone=${String(env.CLAWD_OZONE_PLATFORM || "unset")} `
      + `argvOzone=${parseOzoneArg(argv) || "unset"} `
      + `isolatedUserData=${isolatedUserData}`
  );
  return { buildLabel: BUILD_LABEL, disableGpu, isolatedUserData, processPreflight };
}

function installRuntimeDiagnostics(options = {}) {
  const app = options.app;
  if (
    !app
    || typeof app.whenReady !== "function"
    || typeof app.once !== "function"
  ) return false;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const log = typeof options.log === "function" ? options.log : () => {};
  const setTimeoutFn = options.setTimeout || setTimeout;
  const gpuStatusTimeoutMs = Number.isFinite(options.gpuStatusTimeoutMs)
    ? Math.max(0, options.gpuStatusTimeoutMs)
    : 10000;
  let appReady = false;
  let gpuInfoReady = false;
  let emitted = false;

  async function emitRuntime(source, statusReady) {
    if (emitted) return;
    emitted = true;
    let gpuInfo = null;
    try {
      if (typeof app.getGPUInfo === "function") gpuInfo = await app.getGPUInfo("basic");
    } catch (err) {
      safeLog(log, `Clawd #813 diag3 GPU-INFO-ERROR ${err && err.message ? err.message : String(err)}`);
    }

    let featureStatus = null;
    if (statusReady) {
      try {
        if (typeof app.getGPUFeatureStatus === "function") featureStatus = app.getGPUFeatureStatus();
      } catch {}
    }

    let hardwareAccelerationEnabled = null;
    try {
      if (typeof app.isHardwareAccelerationEnabled === "function") {
        hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
      }
    } catch {}

    let commandLineOzone = "";
    try {
      if (app.commandLine && typeof app.commandLine.getSwitchValue === "function") {
        commandLineOzone = app.commandLine.getSwitchValue("ozone-platform");
      }
    } catch {}

    const primaryDevice = gpuInfo && Array.isArray(gpuInfo.gpuDevice) ? gpuInfo.gpuDevice[0] : null;
    const summary = {
      source,
      gpuStatusReady: statusReady,
      commandLineOzone: commandLineOzone || parseOzoneArg(argv) || "unknown",
      hardwareAccelerationEnabled,
      featureStatus: statusReady ? (featureStatus || {}) : null,
      primaryDevice: primaryDevice ? {
        vendorId: primaryDevice.vendorId,
        deviceId: primaryDevice.deviceId,
        driverVendor: primaryDevice.driverVendor,
        driverVersion: primaryDevice.driverVersion,
      } : null,
      glImplementation: gpuInfo && gpuInfo.auxAttributes
        ? gpuInfo.auxAttributes.glImplementationParts || null
        : null,
    };
    safeLog(log, `Clawd #813 diag3 RUNTIME ${JSON.stringify(summary)}`);
  }

  function maybeEmitReadyStatus() {
    if (!appReady || !gpuInfoReady || emitted) return;
    void emitRuntime("gpu-info-update", true).catch((err) => {
      safeLog(log, `Clawd #813 diag3 RUNTIME-ERROR ${err && err.message ? err.message : String(err)}`);
    });
  }

  app.once("gpu-info-update", () => {
    gpuInfoReady = true;
    maybeEmitReadyStatus();
  });

  Promise.resolve(app.whenReady()).then(() => {
    appReady = true;
    maybeEmitReadyStatus();
    const timer = setTimeoutFn(() => {
      if (emitted) return;
      void emitRuntime("timeout-fallback", false).catch((err) => {
        safeLog(log, `Clawd #813 diag3 RUNTIME-ERROR ${err && err.message ? err.message : String(err)}`);
      });
    }, gpuStatusTimeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }).catch((err) => {
    safeLog(log, `Clawd #813 diag3 RUNTIME-ERROR ${err && err.message ? err.message : String(err)}`);
  });
  return true;
}

function isLiveWindow(win) {
  if (!win) return false;
  try {
    return typeof win.isDestroyed !== "function" || !win.isDestroyed();
  } catch {
    return false;
  }
}

function uniqueLiveWindows(values) {
  return [...new Set(Array.isArray(values) ? values : [])].filter(isLiveWindow);
}

function describeWindow(win) {
  if (!win) return "unknown";
  try {
    if (Number.isInteger(win.id)) return String(win.id);
  } catch {}
  return "no-id";
}

function readWindowBounds(win) {
  if (!isLiveWindow(win) || typeof win.getBounds !== "function") return null;
  try {
    const bounds = win.getBounds();
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  } catch {
    return null;
  }
}

function logPetConfiguration(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const renderBounds = readWindowBounds(options.renderWindow);
  const hitBounds = readWindowBounds(options.hitWindow);
  let display = null;
  try {
    if (renderBounds && options.screen && typeof options.screen.getDisplayMatching === "function") {
      const match = options.screen.getDisplayMatching(renderBounds);
      if (match) {
        display = {
          id: match.id,
          bounds: match.bounds || null,
          workArea: match.workArea || null,
          scaleFactor: match.scaleFactor,
          rotation: match.rotation,
        };
      }
    }
  } catch {}
  const summary = {
    themeId: String(options.themeId || "unknown"),
    variantId: String(options.variantId || "unknown"),
    sizePreference: String(options.sizePreference || "unknown"),
    miniMode: options.miniMode === true,
    lowPowerIdleMode: options.lowPowerIdleMode === true,
    doNotDisturb: options.doNotDisturb === true,
    renderBounds,
    hitBounds,
    display,
  };
  safeLog(log, `Clawd #813 diag3 CONFIG ${JSON.stringify(summary)}`);
  return summary;
}

function createPetWindowTeardownController(options = {}) {
  const BrowserWindow = options.BrowserWindow;
  const getPetWindows = typeof options.getPetWindows === "function" ? options.getPetWindows : () => [];
  const getAllowedAuxWindows = typeof options.getAllowedAuxWindows === "function"
    ? options.getAllowedAuxWindows
    : () => [];
  const getPendingPermissions = typeof options.getPendingPermissions === "function"
    ? options.getPendingPermissions
    : () => [];
  const inspectExternalProcesses = typeof options.inspectExternalProcesses === "function"
    ? options.inspectExternalProcesses
    : () => ({ ok: true, conflicts: [] });
  const setImmediateFn = options.setImmediate || setImmediate;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const checkDelaysMs = Array.isArray(options.checkDelaysMs)
    ? options.checkDelaysMs.slice()
    : DEFAULT_CHECK_DELAYS_MS.slice();
  const log = typeof options.log === "function" ? options.log : () => {};
  let lastResult = Object.freeze({ status: "idle" });
  let invalidated = false;

  function listAllWindows() {
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return null;
    try { return uniqueLiveWindows(BrowserWindow.getAllWindows()); }
    catch { return null; }
  }

  function readOwnedWindows(getter) {
    try { return { ok: true, windows: uniqueLiveWindows(getter()) }; }
    catch { return { ok: false, windows: [] }; }
  }

  function readExternalProcessState() {
    try {
      const result = inspectExternalProcesses();
      if (!result || result.ok !== true || !Array.isArray(result.conflicts)) {
        return { ok: false, conflicts: [] };
      }
      return { ok: true, conflicts: result.conflicts.slice() };
    } catch {
      return { ok: false, conflicts: [] };
    }
  }

  function snapshotStatus(baselineAux, delayMs) {
    const petRead = readOwnedWindows(getPetWindows);
    const livePet = petRead.windows;
    const current = listAllWindows();
    const enumerationOk = Array.isArray(current);
    const newWindows = enumerationOk ? current.filter((win) => !baselineAux.has(win)) : [];
    const external = readExternalProcessState();
    const checkpointValid = petRead.ok
      && enumerationOk
      && livePet.length === 0
      && newWindows.length === 0
      && external.ok
      && external.conflicts.length === 0;
    if (!checkpointValid) invalidated = true;
    const valid = checkpointValid && !invalidated;
    const result = Object.freeze({
      status: valid ? "valid" : "invalid",
      checkpointValid,
      invalidated,
      delayMs,
      livePetWindows: livePet.length,
      newWindows: newWindows.map(describeWindow),
      totalWindows: enumerationOk ? current.length : null,
      enumerationOk,
      externalProcessScanOk: external.ok,
      externalProcesses: external.conflicts,
    });
    lastResult = result;
    safeLog(
      log,
      `Clawd #813 diag3 CHECK +${Math.round(delayMs / 1000)}s `
        + `${valid ? "VALID" : "INVALID"} `
        + `petWindows=${livePet.length} newWindows=${newWindows.length} `
        + `totalWindows=${enumerationOk ? current.length : "unknown"} `
        + `externalProcesses=${external.ok ? external.conflicts.length : "unknown"} `
        + `latched=${invalidated ? "yes" : "no"}`
    );
    return result;
  }

  function performTeardown() {
    const pending = (() => {
      try {
        const value = getPendingPermissions();
        return Array.isArray(value) ? value.filter(Boolean) : ["unknown"];
      } catch {
        return ["unknown"];
      }
    })();
    const targetRead = readOwnedWindows(getPetWindows);
    const allowedRead = readOwnedWindows(getAllowedAuxWindows);
    const targets = targetRead.windows;
    const targetBounds = targets.map(readWindowBounds);
    const allowedAux = new Set(allowedRead.windows);
    const all = listAllWindows();
    const external = readExternalProcessState();
    const targetSet = new Set(targets);
    const enumerationOk = Array.isArray(all);
    const unexpected = enumerationOk
      ? all.filter((win) => !targetSet.has(win) && !allowedAux.has(win))
      : [];

    if (
      pending.length > 0
      || !targetRead.ok
      || !allowedRead.ok
      || !enumerationOk
      || targets.length !== 2
      || unexpected.length > 0
      || !external.ok
      || external.conflicts.length > 0
    ) {
      const result = Object.freeze({
        status: "blocked",
        pendingPermissions: pending.length,
        petWindows: targets.length,
        unexpectedWindows: unexpected.map(describeWindow),
        enumerationOk,
        externalProcessScanOk: external.ok,
        externalProcesses: external.conflicts,
      });
      lastResult = result;
      safeLog(
        log,
        `Clawd #813 diag3 TEARDOWN BLOCKED pending=${pending.length} enumeration=${enumerationOk ? "ok" : "failed"} `
          + `petWindows=${targets.length} unexpectedWindows=${unexpected.length}; `
          + `externalProcesses=${external.ok ? external.conflicts.length : "unknown"}; `
          + "quit active agents and close every Clawd auxiliary window, then restart this diagnostic build"
      );
      return result;
    }

    let destroyed = 0;
    for (const win of targets) {
      try {
        if (isLiveWindow(win) && typeof win.destroy === "function") {
          win.destroy();
          destroyed += 1;
        }
      } catch (err) {
        safeLog(log, `Clawd #813 diag3 TEARDOWN-ERROR ${err && err.message ? err.message : String(err)}`);
      }
    }

    const remaining = listAllWindows();
    if (!Array.isArray(remaining)) {
      lastResult = Object.freeze({ status: "invalid", destroyed, reason: "window-enumeration-failed" });
      safeLog(log, `Clawd #813 diag3 TEARDOWN INVALID destroyedPetWindows=${destroyed} enumeration=failed`);
      return lastResult;
    }
    const remainingUnexpected = remaining.filter((win) => !allowedAux.has(win));
    const teardownValid = destroyed === 2 && remainingUnexpected.length === 0;
    if (!teardownValid) {
      lastResult = Object.freeze({
        status: "invalid",
        destroyed,
        remainingWindows: remaining.map(describeWindow),
        unexpectedWindows: remainingUnexpected.map(describeWindow),
      });
      safeLog(
        log,
        `Clawd #813 diag3 TEARDOWN INVALID destroyedPetWindows=${destroyed} `
          + `remainingWindows=${remaining.length} unexpectedWindows=${remainingUnexpected.length}`
      );
      return lastResult;
    }
    const baselineAux = new Set(allowedAux);
    invalidated = false;
    lastResult = Object.freeze({ status: "destroyed", destroyed, auxiliaryWindows: remaining.length });
    safeLog(
      log,
      `Clawd #813 diag3 TEARDOWN OK destroyedPetWindows=${destroyed} `
        + `auxiliaryWindows=${remaining.length} externalProcesses=0 `
        + `targetBounds=${JSON.stringify(targetBounds)}; wait for CHECK +5s`
    );

    for (const delayMs of checkDelaysMs) {
      const delay = Math.max(0, Number(delayMs) || 0);
      if (delay === 0) {
        snapshotStatus(baselineAux, 0);
        continue;
      }
      const timer = setTimeoutFn(() => snapshotStatus(baselineAux, delay), delay);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
    return lastResult;
  }

  function onPetHiddenChanged(hidden) {
    if (hidden !== true) return false;
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return false;
    setImmediateFn(performTeardown);
    return true;
  }

  return {
    onPetHiddenChanged,
    performTeardown,
    getLastResult: () => lastResult,
  };
}

module.exports = {
  BUILD_LABEL,
  DISABLE_GPU_ARG,
  DEFAULT_CHECK_DELAYS_MS,
  assertNoExternalClawdProcesses,
  configureEarlyRuntime,
  createPetWindowTeardownController,
  inspectExternalClawdProcesses,
  installRuntimeDiagnostics,
  isCurrentAppImageRuntime,
  isClawdMainProcess,
  logPetConfiguration,
  parsePsProcessTable,
  parseOzoneArg,
};
