"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const diagnostic = require("../src/issue-813-diagnostic");

function fakeWindow(id) {
  return {
    id,
    destroyed: false,
    destroyCalls: 0,
    isDestroyed() { return this.destroyed; },
    destroy() {
      this.destroyCalls += 1;
      this.destroyed = true;
    },
    getBounds() { return { x: id * 10, y: id * 20, width: 100, height: 80 }; },
  };
}

describe("issue #813 diagnostic build 3", () => {
  it("keeps the default GPU policy unless the dedicated argument is present", () => {
    let disableCalls = 0;
    const logs = [];
    let userDataPath = null;
    const result = diagnostic.configureEarlyRuntime({
      app: {
        disableHardwareAcceleration: () => { disableCalls += 1; },
        getPath: (name) => {
          assert.equal(name, "temp");
          return "/tmp";
        },
        setPath: (name, value) => {
          assert.equal(name, "userData");
          userDataPath = value;
        },
      },
      argv: ["clawd"],
      env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
      log: (line) => logs.push(line),
      fs: { mkdtempSync: (prefix) => `${prefix}test` },
    });

    assert.equal(result.disableGpu, false);
    assert.equal(disableCalls, 0);
    assert.equal(result.isolatedUserData, "/tmp/clawd-on-desk-issue813-diag3-test");
    assert.equal(userDataPath, result.isolatedUserData);
    assert.match(logs[0], /gpuRequest=default-policy/);
    assert.match(logs[0], /session=wayland/);
    assert.match(logs[0], /isolatedUserData=\/tmp\/clawd-on-desk-issue813-diag3-test/);
  });

  it("requests hardware-acceleration disable before ready only for its exact argument", () => {
    let disableCalls = 0;
    const result = diagnostic.configureEarlyRuntime({
      app: {
        disableHardwareAcceleration: () => { disableCalls += 1; },
        getPath: () => "/tmp",
        setPath: () => {},
      },
      argv: ["clawd", diagnostic.DISABLE_GPU_ARG],
      env: {},
      fs: { mkdtempSync: (prefix) => `${prefix}test` },
    });

    assert.equal(result.disableGpu, true);
    assert.equal(disableCalls, 1);
  });

  it("parses both supported ozone argument forms", () => {
    assert.equal(diagnostic.parseOzoneArg(["clawd", "--ozone-platform=x11"]), "x11");
    assert.equal(diagnostic.parseOzoneArg(["clawd", "--ozone-platform", "wayland"]), "wayland");
    assert.equal(diagnostic.parseOzoneArg(["clawd"]), "");
  });

  it("finds external Clawd main processes while excluding its own relaunch ancestry and helpers", () => {
    const ps = [
      "      1       0 init            /sbin/init",
      "    100       1 clawd-on-desk   /tmp/Clawd.AppImage",
      "    200     100 clawd-on-desk   /tmp/.mount/clawd-on-desk --ozone-platform=x11",
      "    201     200 clawd-on-desk   /tmp/.mount/clawd-on-desk --type=renderer",
      "    300       1 clawd-on-desk   /opt/Clawd/clawd-on-desk",
      "    301     300 clawd-on-desk   /opt/Clawd/clawd-on-desk --type=gpu-process",
    ].join("\n");
    const result = diagnostic.inspectExternalClawdProcesses({
      platform: "linux",
      currentPid: 200,
      execFileSync: (file, args) => {
        assert.equal(file, "ps");
        assert.deepStrictEqual(args, ["-eo", "pid=,ppid=,comm=,args="]);
        return ps;
      },
    });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.ancestorPids, [200, 100, 1]);
    assert.deepStrictEqual(result.conflicts, [{ pid: 300, ppid: 1, comm: "clawd-on-desk" }]);
  });

  it("excludes the current AppImage FUSE daemon even after it daemonizes outside the main ancestry", () => {
    const ps = [
      "      1       0 init             /sbin/init",
      "    100       1 Clawd-on-Desk-0  /opt/Clawd-on-Desk-0.14.0.AppImage",
      "    200       1 clawd-on-desk    /tmp/.mount_Clawd/clawd-on-desk --ozone-platform=x11",
      "    201     200 clawd-on-desk    /tmp/.mount_Clawd/clawd-on-desk --type=renderer",
      "    300       1 clawd-on-desk    /opt/Clawd/clawd-on-desk",
    ].join("\n");
    const result = diagnostic.inspectExternalClawdProcesses({
      platform: "linux",
      currentPid: 200,
      currentAppImagePath: "/opt/Clawd-on-Desk-0.14.0.AppImage",
      execFileSync: () => ps,
      readlinkSync: (procPath) => {
        assert.equal(procPath, "/proc/100/exe");
        return "/opt/Clawd-on-Desk-0.14.0.AppImage";
      },
      realpathSync: (value) => value,
    });

    assert.deepStrictEqual(result.ignoredAppImageRuntimes, [
      { pid: 100, ppid: 1, comm: "Clawd-on-Desk-0" },
    ]);
    assert.deepStrictEqual(result.conflicts, [{ pid: 300, ppid: 1, comm: "clawd-on-desk" }]);
  });

  it("does not exempt an AppImage runtime whose executable is not this launch's AppImage", () => {
    const ps = [
      "1 0 init /sbin/init",
      "100 1 Clawd-on-Desk-0 /opt/other/Clawd.AppImage",
      "200 1 clawd-on-desk /tmp/.mount_Clawd/clawd-on-desk",
    ].join("\n");
    const result = diagnostic.inspectExternalClawdProcesses({
      platform: "linux",
      currentPid: 200,
      currentAppImagePath: "/opt/current/Clawd.AppImage",
      execFileSync: () => ps,
      readlinkSync: () => "/opt/other/Clawd.AppImage",
      realpathSync: (value) => value,
    });

    assert.deepStrictEqual(result.ignoredAppImageRuntimes, []);
    assert.deepStrictEqual(result.conflicts, [{ pid: 100, ppid: 1, comm: "Clawd-on-Desk-0" }]);
  });

  it("keeps a candidate as a conflict when AppImage realpath identity cannot be verified", () => {
    assert.equal(diagnostic.isCurrentAppImageRuntime(
      { pid: 100, ppid: 1, comm: "Clawd-on-Desk-0" },
      {
        currentAppImagePath: "/opt/Clawd.AppImage",
        readlinkSync: () => "/opt/Clawd.AppImage",
        realpathSync: () => { throw new Error("identity unavailable"); },
      }
    ), false);
  });

  it("allows AppImage startup when the only detached candidate is its own FUSE runtime", () => {
    let userDataPath = null;
    const ps = [
      "1 0 init /sbin/init",
      "100 1 Clawd-on-Desk-0 /opt/Clawd.AppImage",
      "200 1 clawd-on-desk /tmp/.mount_Clawd/clawd-on-desk",
    ].join("\n");
    const result = diagnostic.configureEarlyRuntime({
      app: {
        getPath: () => "/tmp",
        setPath: (name, value) => { assert.equal(name, "userData"); userDataPath = value; },
      },
      platform: "linux",
      currentPid: 200,
      argv: ["clawd"],
      env: { APPIMAGE: "/opt/Clawd.AppImage" },
      execFileSync: () => ps,
      readlinkSync: () => "/opt/Clawd.AppImage",
      realpathSync: (value) => value,
      fs: { mkdtempSync: (prefix) => `${prefix}test` },
    });

    assert.equal(result.processPreflight.conflicts.length, 0);
    assert.equal(result.processPreflight.ignoredAppImageRuntimes[0].pid, 100);
    assert.equal(userDataPath, "/tmp/clawd-on-desk-issue813-diag3-test");
  });

  it("fails startup before touching userData when an external Clawd main process exists", () => {
    let tempWrites = 0;
    const ps = [
      "1 0 init /sbin/init",
      "200 1 clawd-on-desk /tmp/diag/clawd-on-desk",
      "300 1 clawd-on-desk /opt/Clawd/clawd-on-desk",
    ].join("\n");
    assert.throws(() => diagnostic.configureEarlyRuntime({
      app: { getPath: () => "/tmp", setPath: () => {} },
      platform: "linux",
      currentPid: 200,
      argv: ["clawd"],
      env: {},
      execFileSync: () => ps,
      fs: { mkdtempSync: () => { tempWrites += 1; return "/tmp/never"; } },
    }), /found another Clawd instance/);
    assert.equal(tempWrites, 0);
  });

  it("fails startup closed when the external process scan cannot be established", () => {
    assert.throws(() => diagnostic.configureEarlyRuntime({
      app: { getPath: () => "/tmp", setPath: () => {} },
      platform: "linux",
      currentPid: 200,
      argv: ["clawd"],
      env: {},
      execFileSync: () => { throw new Error("ps unavailable"); },
    }), /cannot verify external Clawd processes/);
  });

  it("records controlled pet configuration without exposing the full prefs object", () => {
    const logs = [];
    const summary = diagnostic.logPetConfiguration({
      renderWindow: fakeWindow(1),
      hitWindow: fakeWindow(2),
      screen: {
        getDisplayMatching: () => ({
          id: 9,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          scaleFactor: 1.25,
          rotation: 0,
        }),
      },
      themeId: "clawd",
      variantId: "default",
      sizePreference: "P:10",
      lowPowerIdleMode: false,
      log: (line) => logs.push(line),
    });

    assert.equal(summary.display.id, 9);
    assert.deepStrictEqual(summary.renderBounds, { x: 10, y: 20, width: 100, height: 80 });
    assert.match(logs[0], /Clawd #813 diag3 CONFIG/);
    assert.match(logs[0], /"themeId":"clawd"/);
  });

  it("records the resolved ozone switch and actual GPU feature status", async () => {
    const logs = [];
    let gpuInfoUpdateHandler = null;
    const installed = diagnostic.installRuntimeDiagnostics({
      app: {
        whenReady: () => Promise.resolve(),
        once: (eventName, handler) => {
          assert.equal(eventName, "gpu-info-update");
          gpuInfoUpdateHandler = handler;
        },
        getGPUInfo: async () => ({
          gpuDevice: [{ vendorId: 1, deviceId: 2, driverVendor: "test", driverVersion: "3" }],
          auxAttributes: { glImplementationParts: "mock-gl" },
        }),
        getGPUFeatureStatus: () => ({ gpu_compositing: "enabled" }),
        isHardwareAccelerationEnabled: () => true,
        commandLine: { getSwitchValue: () => "x11" },
      },
      argv: ["clawd", "--ozone-platform=x11"],
      log: (line) => logs.push(line),
      setTimeout: () => ({ unref() {} }),
    });

    assert.equal(installed, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 0);
    assert.equal(typeof gpuInfoUpdateHandler, "function");
    gpuInfoUpdateHandler();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /"source":"gpu-info-update"/);
    assert.match(logs[0], /"gpuStatusReady":true/);
    assert.match(logs[0], /"commandLineOzone":"x11"/);
    assert.match(logs[0], /"hardwareAccelerationEnabled":true/);
    assert.match(logs[0], /"gpu_compositing":"enabled"/);
    assert.match(logs[0], /"glImplementation":"mock-gl"/);
  });

  it("fails GPU feature status closed when gpu-info-update never arrives", async () => {
    const logs = [];
    let timeoutHandler = null;
    diagnostic.installRuntimeDiagnostics({
      app: {
        whenReady: () => Promise.resolve(),
        once: () => {},
        getGPUInfo: async () => ({ gpuDevice: [] }),
        getGPUFeatureStatus: () => { throw new Error("must not be called before gpu-info-update"); },
        isHardwareAccelerationEnabled: () => false,
        commandLine: { getSwitchValue: () => "wayland" },
      },
      log: (line) => logs.push(line),
      setTimeout: (handler) => {
        timeoutHandler = handler;
        return { unref() {} };
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof timeoutHandler, "function");
    timeoutHandler();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 1);
    assert.match(logs[0], /"source":"timeout-fallback"/);
    assert.match(logs[0], /"gpuStatusReady":false/);
    assert.match(logs[0], /"featureStatus":null/);
  });

  it("destroys only the two owned pet windows and detects later window pollution", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const windows = [pet, hit];
    const immediate = [];
    const timers = [];
    const logs = [];
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => windows.filter((win) => !win.destroyed) },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [],
      setImmediate: (fn) => immediate.push(fn),
      setTimeout: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; },
      checkDelaysMs: [0, 5000, 30000],
      log: (line) => logs.push(line),
    });

    assert.equal(controller.onPetHiddenChanged(true), true);
    assert.equal(pet.destroyCalls, 0);
    immediate[0]();

    assert.equal(pet.destroyCalls, 1);
    assert.equal(hit.destroyCalls, 1);
    assert.equal(controller.getLastResult().status, "valid");
    assert.match(logs.join("\n"), /TEARDOWN OK/);
    assert.match(logs.join("\n"), /CHECK \+0s VALID/);

    const lateWindow = fakeWindow(4);
    windows.push(lateWindow);
    assert.equal(timers.length, 2);
    assert.equal(timers[0].delay, 5000);
    timers[0].fn();
    assert.equal(controller.getLastResult().status, "invalid");
    assert.deepStrictEqual(controller.getLastResult().newWindows, ["4"]);

    lateWindow.destroyed = true;
    assert.equal(timers.length, 2);
    assert.equal(timers[1].delay, 30000);
    timers[1].fn();
    assert.equal(controller.getLastResult().status, "invalid");
    assert.equal(controller.getLastResult().checkpointValid, true);
    assert.equal(controller.getLastResult().invalidated, true);
    assert.match(logs.join("\n"), /CHECK \+30s INVALID.*latched=yes/);
  });

  it("blocks teardown while any permission is pending", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const permissionBubble = fakeWindow(9);
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => [pet, hit, permissionBubble] },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [{ bubble: permissionBubble }],
      setImmediate: (fn) => fn(),
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "blocked");
    assert.equal(controller.getLastResult().pendingPermissions, 1);
    assert.equal(pet.destroyCalls, 0);
    assert.equal(hit.destroyCalls, 0);
    assert.equal(permissionBubble.destroyCalls, 0);
  });

  it("blocks teardown when another Clawd main process appears", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => [pet, hit] },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [],
      inspectExternalProcesses: () => ({
        ok: true,
        conflicts: [{ pid: 300, ppid: 1, comm: "clawd-on-desk" }],
      }),
      setImmediate: (fn) => fn(),
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "blocked");
    assert.equal(controller.getLastResult().externalProcesses[0].pid, 300);
    assert.equal(pet.destroyCalls, 0);
    assert.equal(hit.destroyCalls, 0);
  });

  it("latches invalid when another Clawd main process appears after teardown", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const timers = [];
    let scans = 0;
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => [pet, hit].filter((win) => !win.destroyed) },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [],
      inspectExternalProcesses: () => {
        scans += 1;
        if (scans >= 3) {
          return { ok: true, conflicts: [{ pid: 300, ppid: 1, comm: "clawd-on-desk" }] };
        }
        return { ok: true, conflicts: [] };
      },
      setImmediate: (fn) => fn(),
      setTimeout: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; },
      checkDelaysMs: [0, 5000, 30000],
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "valid");
    assert.equal(timers.length, 2);

    timers[0].fn();
    assert.equal(controller.getLastResult().status, "invalid");
    assert.equal(controller.getLastResult().externalProcesses[0].pid, 300);

    scans = 0;
    timers[1].fn();
    assert.equal(controller.getLastResult().status, "invalid");
    assert.equal(controller.getLastResult().checkpointValid, true);
    assert.equal(controller.getLastResult().invalidated, true);
  });

  it("blocks teardown when the permission snapshot is not an array", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => [pet, hit] },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => undefined,
      setImmediate: (fn) => fn(),
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "blocked");
    assert.equal(controller.getLastResult().pendingPermissions, 1);
    assert.equal(pet.destroyCalls, 0);
    assert.equal(hit.destroyCalls, 0);
  });

  it("blocks teardown for every unrecognized auxiliary window", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const settings = fakeWindow(4);
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => [pet, hit, settings] },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [],
      setImmediate: (fn) => fn(),
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "blocked");
    assert.deepStrictEqual(controller.getLastResult().unexpectedWindows, ["4"]);
    assert.equal(pet.destroyCalls, 0);
    assert.equal(hit.destroyCalls, 0);
    assert.equal(settings.destroyCalls, 0);
  });

  it("invalidates teardown when a window appears during synchronous destruction", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const lateWindow = fakeWindow(5);
    const windows = [pet, hit];
    pet.destroy = function destroyWithPollution() {
      this.destroyCalls += 1;
      this.destroyed = true;
      windows.push(lateWindow);
    };
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => windows.filter((win) => !win.destroyed) },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [],
      setImmediate: (fn) => fn(),
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "invalid");
    assert.deepStrictEqual(controller.getLastResult().unexpectedWindows, ["5"]);
  });

  it("fails closed when BrowserWindow enumeration is unavailable", () => {
    const pet = fakeWindow(1);
    const hit = fakeWindow(2);
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => { throw new Error("enumeration failed"); } },
      getPetWindows: () => [pet, hit],
      getPendingPermissions: () => [],
      setImmediate: (fn) => fn(),
    });

    controller.onPetHiddenChanged(true);
    assert.equal(controller.getLastResult().status, "blocked");
    assert.equal(controller.getLastResult().enumerationOk, false);
    assert.equal(pet.destroyCalls, 0);
    assert.equal(hit.destroyCalls, 0);
  });

  it("does nothing when the pet becomes visible", () => {
    let enumerated = false;
    const controller = diagnostic.createPetWindowTeardownController({
      BrowserWindow: { getAllWindows: () => { enumerated = true; return []; } },
    });

    assert.equal(controller.onPetHiddenChanged(false), false);
    assert.equal(enumerated, false);
  });
});
