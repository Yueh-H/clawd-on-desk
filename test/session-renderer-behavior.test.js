"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

class FakeClassList {
  constructor(element) { this.element = element; }
  add(...names) {
    const set = new Set(this.element.className.split(/\s+/).filter(Boolean));
    for (const name of names) set.add(name);
    this.element.className = [...set].join(" ");
  }
  contains(name) { return this.element.className.split(/\s+/).includes(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  async dispatch(name) {
    const event = { stopPropagation() {}, preventDefault() {}, key: "" };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
  querySelector(selector) {
    if (!selector.startsWith(".")) return null;
    return byClass(this, selector.slice(1))[0] || null;
  }
  replaceWith() {}
  focus() {}
  select() {}
}

function createDocument(ids) {
  const elements = new Map(ids.map((id) => [id, new FakeElement("div")]));
  return {
    title: "",
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
    elements,
  };
}

function descendants(root) {
  const result = [];
  for (const child of root.children || []) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function byClass(root, className) {
  return descendants(root).filter((element) =>
    element.classList && element.classList.contains(className));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function translations() {
  return {
    dashboardWindowTitle: "Sessions",
    dashboardCount: "{n} active",
    dashboardJumpTerminal: "Jump",
    dashboardOpenClaudeSession: "Open Claude Session",
    dashboardOpenCodexSession: "Open Codex Session",
    dashboardOpenFolder: "Open Folder",
    dashboardUnknownAgent: "Unknown",
    sessionFocusUnavailableRemote: "Remote sessions cannot focus a terminal on this computer.",
    sessionFocusUnavailableWebui: "WebUI sessions do not have a local terminal window.",
    sessionFocusUnavailableMissingTerminalInfo: "This session did not provide terminal window information.",
    sessionOpenFolderFailed: "Could not open folder: {reason}",
    sessionOpenFolderUnavailable: "This folder is no longer available.",
    sessionJustNow: "now",
    sessionHudElapsedSec: "{n}s",
    sessionHudDoubleClickToFocus: "Double-click to open this session",
    sessionHudDeleteSession: "Remove from Clawd",
    sessionHudDeleteFailed: "Could not remove this session.",
    sessionHudReconnectSession: "Reconnect this session",
    sessionHudReconnectStarted: "The original session was opened.",
    sessionHudReconnectFailed: "Could not reconnect this session.",
    sessionMinAgo: "{n}m",
    sessionHrAgo: "{n}h",
    sessionBadgeIdle: "Idle",
    sessionLocal: "Local",
    sessionAutomationLabel: "Session automation",
    sessionAutomationFollowGlobal: "Follow global",
    sessionAutomationAsk: "Always ask",
    sessionAutomationAutoTools: "Auto-allow tools",
    sessionAutomationUnavailable: "Unavailable",
    sessionAutomationChangeFailed: "Could not update session automation.",
    sessionAutomationOrphansTitle: "Ended or hidden sessions",
    sessionAutomationOrphansHint: "These overrides remain active until revoked.",
    sessionAutomationRevoke: "Revoke",
    dashboardKimiQuotaRefresh: "Refresh Kimi quota",
    dashboardKimiQuotaRefreshing: "Refreshing Kimi…",
    dashboardKimiQuotaUpdated: "Kimi quota updated.",
    dashboardKimiQuotaRefreshFailed: "Refresh failed: {reason}",
    dashboardKimiQuotaEmpty: "No quota data yet. Click refresh to fetch it.",
    dashboardKimiQuotaRefreshShort: "Refresh",
  };
}

function session(id, overrides = {}) {
  return {
    id,
    displayTitle: id,
    state: "idle",
    badge: "idle",
    updatedAt: Date.now(),
    canFocus: false,
    sourceType: "local",
    host: null,
    platform: null,
    cwd: "/safe/project",
    ...overrides,
  };
}

async function loadDashboard(
  sessions,
  openResult = { status: "ok" },
  snapshotOverrides = {},
  automationResult = { status: "applied" },
  kimiOptions = {}
) {
  const document = createDocument([
    "title",
    "count",
    "content",
    "quotaSummary",
  ]);
  const openCalls = [];
  const automationCalls = [];
  const kimiRefreshCalls = [];
  let renderInterval = null;
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: () => {},
    getI18n: async () => ({ lang: "en", translations: translations() }),
    getSnapshot: async () => ({
      sessions,
      groups: [{ host: "", ids: sessions.map((s) => s.id) }],
      ...snapshotOverrides,
    }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: () => {},
    ackCompletion: async () => ({ status: "noop" }),
    hideSession: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async (payload) => {
      automationCalls.push(["set", payload]);
      return typeof automationResult === "function"
        ? automationResult("set", payload)
        : automationResult;
    },
    clearSessionAutomationGrant: async (payload) => {
      automationCalls.push(["clear", payload]);
      return typeof automationResult === "function"
        ? automationResult("clear", payload)
        : automationResult;
    },
    getKimiQuotaStatus: async () => kimiOptions.status || {
      status: "ok",
      configured: false,
      decryptable: false,
      collectionEnabled: false,
      agentEnabled: true,
    },
    refreshKimiQuota: async () => {
      kimiRefreshCalls.push(true);
      return kimiOptions.refreshResult || { status: "ok" };
    },
  };
  const context = vm.createContext({
    window: { dashboardAPI: api }, document, console, Intl, Date,
    setInterval: (callback) => { renderInterval = callback; return 1; },
    requestAnimationFrame: (cb) => cb(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"), context);
  await flush();
  return {
    root: document.elements.get("content"),
    quotaSummary: document.elements.get("quotaSummary"),
    openCalls,
    automationCalls,
    kimiRefreshCalls,
    tickRender: () => { if (renderInterval) renderInterval(); },
  };
}

async function loadHud(
  sessions,
  openResult = { status: "ok" },
  snapshotOverrides = {},
  resumeResult = { status: "ok" }
) {
  const document = createDocument(["hud"]);
  const openCalls = [];
  const focusCalls = [];
  const ackCalls = [];
  const sessionMenuCalls = [];
  const deleteCalls = [];
  const resumeCalls = [];
  let snapshotListener = null;
  let feedbackTimeout = null;
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: (listener) => { snapshotListener = listener; },
    getI18n: async () => ({ lang: "en", translations: translations() }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: (...args) => { focusCalls.push(args); },
    showSessionMenu: async (...args) => {
      sessionMenuCalls.push(args);
      return { status: "ok" };
    },
    deleteSession: async (...args) => {
      deleteCalls.push(args);
      return { status: "ok" };
    },
    resumeSession: async (...args) => {
      resumeCalls.push(args);
      return typeof resumeResult === "function" ? resumeResult(...args) : resumeResult;
    },
    ackCompletion: async (...args) => {
      ackCalls.push(args);
      return { status: "noop" };
    },
    openDashboard: () => {},
    setPinned: () => {},
  };
  const context = vm.createContext({
    window: { sessionHudAPI: api }, document, console, Date,
    setInterval: () => 0,
    setTimeout: (callback) => { feedbackTimeout = callback; return 1; },
    clearTimeout: () => { feedbackTimeout = null; },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8"), context);
  await flush();
  snapshotListener({ sessions, orderedIds: sessions.map((entry) => entry.id), ...snapshotOverrides });
  return {
    root: document.elements.get("hud"),
    openCalls,
    focusCalls,
    ackCalls,
    sessionMenuCalls,
    deleteCalls,
    resumeCalls,
    pushSnapshot: (nextSessions = sessions, nextSnapshotOverrides = {}) => snapshotListener({
      sessions: nextSessions,
      orderedIds: nextSessions.map((entry) => entry.id),
      ...snapshotOverrides,
      ...nextSnapshotOverrides,
    }),
    expireFeedback: async () => {
      const callback = feedbackTimeout;
      feedbackTimeout = null;
      if (callback) callback();
      await flush();
    },
  };
}

test("HUD right-click requests the native remove-session menu without focusing", async () => {
  const hud = await loadHud([session("active", { state: "working", badge: "running", canFocus: true })]);
  const row = byClass(hud.root, "row")[0];

  await row.dispatch("contextmenu");
  await flush();

  assert.deepStrictEqual(hud.sessionMenuCalls, [["active"]]);
  assert.deepStrictEqual(hud.focusCalls, []);
  assert.deepStrictEqual(hud.ackCalls, []);
});

test("Dashboard renders local/remote/webui reasons and only local folder action", async () => {
  const { root } = await loadDashboard([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  assert.strictEqual(byClass(root, "card-unfocusable").length, 3);
  assert.deepStrictEqual(byClass(root, "focus-unavailable-reason").map((el) => el.textContent), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("Dashboard hosts the manual Kimi quota refresh inside the Kimi quota section", async () => {
  const dashboard = await loadDashboard(
    [],
    { status: "ok" },
    {},
    { status: "applied" },
    {
      status: {
        status: "ok",
        configured: true,
        decryptable: true,
        collectionEnabled: true,
        agentEnabled: true,
      },
    }
  );

  // Connected but nothing reported yet: the section stays visible with an
  // empty hint so the refresh that fetches the first numbers has a home.
  const button = byClass(dashboard.quotaSummary, "quota-refresh-button")[0];
  assert.ok(button, "Kimi quota section header should host the refresh button");
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.title, "Refresh Kimi quota");
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-empty-hint").length, 1);

  await button.dispatch("click");
  await flush();

  assert.strictEqual(dashboard.kimiRefreshCalls.length, 1);
  assert.strictEqual(button.disabled, false);
  const feedback = byClass(dashboard.quotaSummary, "quota-refresh-feedback")[0];
  assert.ok(feedback, "Kimi quota section header should host the refresh feedback");
  assert.strictEqual(feedback.hidden, false);
  assert.strictEqual(feedback.textContent, "Kimi quota updated.");
});

test("Dashboard renders no Kimi quota section or refresh for a disconnected key", async () => {
  const dashboard = await loadDashboard([]);

  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-refresh-button").length, 0);
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-section").length, 0);
});

test("Dashboard renders the resolved custom agent name instead of its raw id", async () => {
  const { root } = await loadDashboard([
    session("custom", {
      agentId: "custom-nova-0123456789ab",
      agentName: "Nova AI",
    }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Nova AI/);
  assert.doesNotMatch(renderedText, /custom-nova/);
});

test("Dashboard keeps curated labels for built-in agents", async () => {
  const { root } = await loadDashboard([
    session("codex", { agentId: "codex", agentName: "Codex CLI" }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Codex/);
  assert.doesNotMatch(renderedText, /Codex CLI/);
});

test("Dashboard labels exact app session focus separately from terminal focus", async () => {
  const { root } = await loadDashboard([
    session("claude", { agentId: "claude-code", canFocus: true }),
    session("codex", {
      agentId: "codex",
      canFocus: true,
      focusTarget: { type: "codex-thread" },
    }),
    session("terminal", { agentId: "gemini-cli", canFocus: true }),
  ]);

  assert.deepStrictEqual(
    byClass(root, "actions").map((actions) => actions.children[0].textContent),
    ["Open Claude Session", "Open Codex Session", "Jump"]
  );
});

test("Dashboard folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadDashboard([session("local")], { status: "error", message: "denied" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  const feedback = byClass(root, "session-action-feedback")[0];
  assert.ok(feedback);
  assert.strictEqual(feedback.attributes["aria-live"], "polite");
  assert.strictEqual(feedback.textContent, "Could not open folder: denied");
});

test("Dashboard preserves folder pending and failure state across interval renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const { root, openCalls, tickRender } = await loadDashboard(
    [session("local")],
    () => pendingResult
  );

  const clickPromise = byClass(root, "open-folder-button")[0].dispatch("click");
  await flush();
  tickRender();

  const replacementButton = byClass(root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);

  resolveOpen({ status: "error", message: "slow denial" });
  await clickPromise;
  tickRender();
  assert.strictEqual(
    byClass(root, "session-action-feedback")[0].textContent,
    "Could not open folder: slow denial"
  );
  assert.strictEqual(byClass(root, "open-folder-button")[0].disabled, false);
});

test("Dashboard session automation sends only sessionId/mode and exact grantId", async () => {
  const configurable = session("configurable", {
    canConfigureSessionAutomation: true,
    sessionAutomationMode: "inherit",
  });
  const activeButIneligible = session("active", {
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "auto-tools",
    sessionAutomationGrantId: "grant-current",
  });
  const { root, automationCalls } = await loadDashboard([configurable, activeButIneligible]);
  const selects = byClass(root, "session-automation-select");

  selects[0].value = "off";
  await selects[0].dispatch("change");
  selects[1].value = "inherit";
  await selects[1].dispatch("change");

  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["set", { sessionId: "configurable", mode: "off" }],
    ["clear", { grantId: "grant-current" }],
  ]);
});

test("Dashboard renders and revokes an orphan grant by exact grantId", async () => {
  const { root, automationCalls } = await loadDashboard([], { status: "ok" }, {
    sessionAutomationOrphans: [{
      agentId: "claude-code",
      sessionId: "ended",
      mode: "auto-tools",
      displayLabel: "Ended project",
      sessionAutomationGrantId: "grant-orphan",
    }],
  });

  assert.strictEqual(byClass(root, "automation-orphan-card").length, 1);
  assert.strictEqual(byClass(root, "automation-orphan-title")[0].textContent, "Ended project");
  const revoke = byClass(root, "automation-orphan-card")[0].children[1];
  await revoke.dispatch("click");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["clear", { grantId: "grant-orphan" }],
  ]);
});

test("Dashboard keeps session automation failure feedback visible after rerender", async () => {
  const { root } = await loadDashboard([
    session("configurable", {
      canConfigureSessionAutomation: true,
      sessionAutomationMode: "inherit",
    }),
  ], { status: "ok" }, {}, { status: "full" });
  const select = byClass(root, "session-automation-select")[0];
  select.value = "auto-tools";
  await select.dispatch("change");

  assert.strictEqual(byClass(root, "session-automation-select")[0].value, "inherit");
  assert.strictEqual(
    byClass(root, "session-automation-feedback")[0].textContent,
    "Could not update session automation."
  );
});

test("HUD unfocusable click explains why and offers folder only for local non-webui", async () => {
  const { root } = await loadHud([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  const rows = byClass(root, "row-unfocusable");
  assert.deepStrictEqual(rows.map((row) => row.title), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);
  await rows[0].dispatch("click");
  assert.strictEqual(
    byClass(root, "session-inline-feedback")[0].textContent,
    "This session did not provide terminal window information."
  );
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("HUD shows the agent name and focuses only after a row double-click", async () => {
  const harness = await loadHud([
    session("focusable", {
      agentId: "codex",
      agentName: "Codex",
      canFocus: true,
    }),
  ]);
  const row = byClass(harness.root, "row-focusable")[0];

  assert.ok(row);
  assert.strictEqual(byClass(harness.root, "row-index")[0].textContent, "1");
  assert.strictEqual(byClass(harness.root, "agent-name")[0].textContent, "Codex");
  assert.strictEqual(row.title, "Double-click to open this session");

  await row.dispatch("click");
  assert.deepStrictEqual(harness.focusCalls, []);
  assert.deepStrictEqual(harness.ackCalls, [["focusable"]]);

  await row.dispatch("dblclick");
  assert.deepStrictEqual(harness.focusCalls, [["focusable"]]);
  assert.deepStrictEqual(harness.ackCalls, [["focusable"]]);
});

test("HUD clears a completion bell acknowledged by an indexed shortcut", async () => {
  const running = session("shortcut", {
    state: "working",
    badge: "running",
    canFocus: true,
  });
  const done = session("shortcut", {
    state: "idle",
    badge: "done",
    canFocus: true,
  });
  const harness = await loadHud([running]);

  harness.pushSnapshot([done]);
  assert.strictEqual(byClass(harness.root, "completion-bell").length, 1);

  harness.pushSnapshot([done], { acknowledgedCompletionIds: ["shortcut"] });
  assert.strictEqual(byClass(harness.root, "completion-bell").length, 0);

  harness.pushSnapshot([done], { acknowledgedCompletionIds: ["shortcut"] });
  assert.strictEqual(byClass(harness.root, "completion-bell").length, 0);

  harness.pushSnapshot([running]);
  harness.pushSnapshot([{ ...done, updatedAt: Date.now() + 1 }]);
  assert.strictEqual(byClass(harness.root, "completion-bell").length, 1);
});

test("HUD hides ordinary idle rows but keeps sessions waiting for input", async () => {
  const { root } = await loadHud([
    session("idle"),
    session("waiting", { lastEvent: { rawEvent: "Elicitation" } }),
    session("running", { state: "working", badge: "running" }),
    session("done", { badge: "done" }),
  ], undefined, { hudShowIdle: false });

  assert.deepStrictEqual(
    byClass(root, "title").map((element) => element.textContent),
    ["waiting", "running", "done"]
  );
  assert.deepStrictEqual(
    byClass(root, "row-index").map((element) => element.textContent),
    ["1", "2", "3"]
  );
});

test("HUD manual retention shows a visible remove control that deletes only that session id", async () => {
  const harness = await loadHud([session("kept")], undefined, {
    hudShowIdle: true,
    hudManualRetention: true,
  });
  const remove = byClass(harness.root, "remove-session-button");
  assert.strictEqual(remove.length, 1);
  assert.strictEqual(remove[0].title, "Remove from Clawd");
  await remove[0].dispatch("click");
  assert.deepStrictEqual(harness.deleteCalls, [["kept"]]);
  assert.deepStrictEqual(harness.focusCalls, []);

  harness.pushSnapshot([session("ordinary")], { hudManualRetention: false });
  assert.strictEqual(byClass(harness.root, "remove-session-button").length, 0);
});

test("HUD reconnect control resumes only the selected retained session", async () => {
  const harness = await loadHud([
    session("kept", { manualRetained: true, canResume: true }),
    session("unsupported", { manualRetained: true, canResume: false }),
  ], undefined, {
    hudShowIdle: true,
    hudManualRetention: true,
  });

  const reconnect = byClass(harness.root, "resume-session-button");
  assert.strictEqual(reconnect.length, 1);
  assert.strictEqual(reconnect[0].title, "Reconnect this session");
  await reconnect[0].dispatch("click");

  assert.deepStrictEqual(harness.resumeCalls, [["kept"]]);
  assert.deepStrictEqual(harness.focusCalls, []);
  assert.strictEqual(
    byClass(harness.root, "session-inline-feedback")[0].textContent,
    "The original session was opened."
  );
});

test("HUD jump gesture automatically resumes and opens a retained session", async () => {
  const harness = await loadHud([
    session("kept", { manualRetained: true, canResume: true }),
  ], undefined, {
    hudShowIdle: true,
    hudManualRetention: true,
  });

  const row = byClass(harness.root, "row-focusable")[0];
  assert.ok(row, "a resumable historical row remains navigable while idle and grey");
  assert.strictEqual(row.title, "Double-click to open this session");
  assert.strictEqual(byClass(harness.root, "dot-idle").length, 1);

  await row.dispatch("click");
  assert.deepStrictEqual(harness.resumeCalls, []);
  assert.strictEqual(byClass(harness.root, "session-inline-feedback").length, 0);

  await row.dispatch("dblclick");
  assert.deepStrictEqual(harness.resumeCalls, [["kept"]]);
  assert.deepStrictEqual(harness.focusCalls, []);
  assert.strictEqual(byClass(harness.root, "dot-idle").length, 1);
  assert.strictEqual(
    byClass(harness.root, "session-inline-feedback")[0].textContent,
    "The original session was opened."
  );
});

test("HUD reconnect control exposes a localized failure", async () => {
  const harness = await loadHud([
    session("kept", { manualRetained: true, canResume: true }),
  ], undefined, {
    hudShowIdle: true,
    hudManualRetention: true,
  }, { status: "error", reason: "agent-cli-unavailable" });

  await byClass(harness.root, "resume-session-button")[0].dispatch("click");
  assert.strictEqual(
    byClass(harness.root, "session-inline-feedback")[0].textContent,
    "Could not reconnect this session."
  );
});

test("HUD folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadHud([session("local")], { status: "not-available" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  assert.strictEqual(byClass(root, "session-inline-feedback")[0].textContent, "This folder is no longer available.");
});

test("HUD preserves folder pending state across snapshot renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const harness = await loadHud([session("local")], () => pendingResult);

  const clickPromise = byClass(harness.root, "open-folder-button")[0].dispatch("click");
  await flush();
  harness.pushSnapshot();

  const replacementButton = byClass(harness.root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(harness.openCalls, [["local"]]);

  resolveOpen({ status: "ok" });
  await clickPromise;
  assert.strictEqual(byClass(harness.root, "open-folder-button")[0].disabled, false);
});

test("HUD feedback survives snapshot renders and clears on its timeout", async () => {
  const harness = await loadHud([session("local")]);
  await byClass(harness.root, "row-unfocusable")[0].dispatch("click");
  harness.pushSnapshot();
  assert.strictEqual(
    byClass(harness.root, "session-inline-feedback")[0].textContent,
    "This session did not provide terminal window information."
  );

  await harness.expireFeedback();
  assert.strictEqual(byClass(harness.root, "session-inline-feedback").length, 0);
  assert.strictEqual(byClass(harness.root, "title")[0].textContent, "local");
});

test("HUD interaction and folder feedback copy exists in all supported languages", () => {
  const keys = [
    "dashboardOpenFolder",
    "sessionHudDoubleClickToFocus",
    "sessionHudDeleteSession",
    "sessionHudDeleteFailed",
    "sessionHudReconnectSession",
    "sessionHudReconnectStarted",
    "sessionHudReconnectFailed",
    "sessionOpenFolderFailed",
    "sessionOpenFolderUnavailable",
    "sessionFocusUnavailableRemote",
    "sessionFocusUnavailableWebui",
    "sessionFocusUnavailableMissingTerminalInfo",
  ];
  for (const lang of SUPPORTED_LANGS) {
    for (const key of keys) assert.ok(i18n[lang][key], `${lang}.${key} is required`);
  }
});
