"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { makeSessionKey } = require("../src/session-key");
const {
  detectAntigravitySurface,
  getRetainedSessionResumeTarget,
  resolveCodexThreadIdFromHistory,
  resumeRetainedSession,
} = require("../src/retained-session-resume");

const CODEX_ID = "019e115a-4df2-7ed0-b90e-8e6345aca777";
const CLAUDE_ID = "be45d95f-b282-4d03-95f1-c8898811fd23";
const ANTIGRAVITY_ID = "693b2deb-295f-451c-ae37-c2b9bbb76d77";
const OPENCODE_ID = "ses_2aB3cD4eF5gH6jK7";

function retained(agentId, rawSessionId, overrides = {}) {
  return {
    id: makeSessionKey({ profileId: "local", rawSessionId }),
    profileId: "local",
    rawSessionId,
    agentId,
    manualRetained: true,
    cwd: "/safe/project",
    ...overrides,
  };
}

function directoryStat() {
  return { isDirectory: () => true };
}

test("retained resume targets preserve the agent-specific conversation identity", () => {
  assert.deepStrictEqual(getRetainedSessionResumeTarget(retained("codex", `codex:${CODEX_ID}`, {
    codexOriginator: "Codex Desktop",
  }), { osPlatform: "darwin" }), {
    canResume: true,
    type: "codex-thread",
    sessionId: CODEX_ID,
    url: `codex://threads/${CODEX_ID}`,
  });
  assert.deepStrictEqual(getRetainedSessionResumeTarget(retained("codex", `codex:${CODEX_ID}`, {
    codexOriginator: "codex-tui",
  }), { osPlatform: "darwin" }), {
    canResume: true,
    type: "codex-cli",
    sessionId: CODEX_ID,
    url: null,
  });
  assert.deepStrictEqual(getRetainedSessionResumeTarget(retained(
    "codex",
    `codex:fb7a22c28cd4_${ANTIGRAVITY_ID}`,
    { codexOriginator: "Codex Desktop" }
  ), { osPlatform: "darwin" }), {
    canResume: true,
    type: "codex-history",
    sessionId: ANTIGRAVITY_ID,
    url: null,
  });
  assert.deepStrictEqual(getRetainedSessionResumeTarget(retained("claude-code", CLAUDE_ID)), {
    canResume: true,
    type: "claude-cli",
    sessionId: CLAUDE_ID,
    url: null,
  });
  assert.deepStrictEqual(getRetainedSessionResumeTarget(retained(
    "antigravity-cli",
    `antigravity:${ANTIGRAVITY_ID}`
  )), {
    canResume: true,
    type: "antigravity-auto",
    sessionId: ANTIGRAVITY_ID,
    url: null,
  });
  assert.deepStrictEqual(getRetainedSessionResumeTarget(retained(
    "opencode",
    `opencode:${OPENCODE_ID}`
  )), {
    canResume: true,
    type: "opencode-cli",
    sessionId: OPENCODE_ID,
    url: null,
  });
});

test("retained resume targets reject live, remote, WebUI, and malformed records", () => {
  for (const entry of [
    { ...retained("claude-code", CLAUDE_ID), manualRetained: false },
    retained("claude-code", CLAUDE_ID, { host: "remote-box" }),
    retained("claude-code", CLAUDE_ID, { platform: "webui" }),
    retained("codex", "codex:not-a-uuid", { codexOriginator: "Codex Desktop" }),
    retained("opencode", "opencode:unsafe session"),
  ]) {
    assert.strictEqual(getRetainedSessionResumeTarget(entry).canResume, false);
  }
});

test("Codex Desktop retained sessions reopen the exact app task", async () => {
  const urls = [];
  const result = await resumeRetainedSession(retained("codex", `codex:${CODEX_ID}`, {
    codexOriginator: "Codex Desktop",
  }), {
    osPlatform: "darwin",
    openCodexThread: async (url) => { urls.push(url); return true; },
  });

  assert.deepStrictEqual(result, { status: "ok", action: "open-codex-thread" });
  assert.deepStrictEqual(urls, [`codex://threads/${CODEX_ID}`]);
});

test("composite Codex Desktop ids resolve session_meta before opening the task", async () => {
  const urls = [];
  const result = await resumeRetainedSession(retained(
    "codex",
    `codex:fb7a22c28cd4_${ANTIGRAVITY_ID}`,
    { codexOriginator: "Codex Desktop" }
  ), {
    osPlatform: "darwin",
    resolveCodexThreadIdFromHistory: async () => CODEX_ID,
    openCodexThread: async (url) => { urls.push(url); return true; },
  });

  assert.deepStrictEqual(result, { status: "ok", action: "open-codex-thread" });
  assert.deepStrictEqual(urls, [`codex://threads/${CODEX_ID}`]);
});

test("Codex history resolver reads the unique rollout session_meta id", () => {
  const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-history-"));
  try {
    const dayDir = path.join(codexDir, "sessions", "2026", "08", "25");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(
      path.join(dayDir, `rollout-example_${ANTIGRAVITY_ID}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID } })}\n`
    );
    assert.strictEqual(
      resolveCodexThreadIdFromHistory({}, ANTIGRAVITY_ID, { codexDir }),
      CODEX_ID
    );
  } finally {
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test("Claude retained sessions launch --resume in the stored project directory", async () => {
  const launches = [];
  const result = await resumeRetainedSession(retained("claude-code", CLAUDE_ID), {
    osPlatform: "darwin",
    statSync: () => directoryStat(),
    launchClaudeSession: async (...args) => {
      launches.push(args);
      return { ok: true, terminal: "osascript" };
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(launches, [["resume", "/safe/project", CLAUDE_ID]]);
});

test("Codex CLI retained sessions launch codex resume with argv-safe terminal quoting", async () => {
  const launches = [];
  const result = await resumeRetainedSession(retained("codex", `codex:${CODEX_ID}`, {
    codexOriginator: "codex-tui",
  }), {
    osPlatform: "darwin",
    statSync: () => directoryStat(),
    findResumeExecutable: async () => "/safe/bin/codex",
    tryLaunch: async (bin, args, opts) => {
      launches.push({ bin, args, opts });
      return { ok: true };
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(launches[0].bin, "osascript");
  assert.match(launches[0].args[1], /codex.*resume.*019e115a/);
  assert.strictEqual(launches[0].opts.cwd, "/safe/project");
});

test("OpenCode retained sessions launch the exact --session in the stored project directory", async () => {
  const launches = [];
  const result = await resumeRetainedSession(retained("opencode", `opencode:${OPENCODE_ID}`), {
    osPlatform: "darwin",
    statSync: () => directoryStat(),
    findResumeExecutable: async () => "/safe/bin/opencode",
    tryLaunch: async (bin, args, opts) => {
      launches.push({ bin, args, opts });
      return { ok: true };
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(launches[0].bin, "osascript");
  assert.match(launches[0].args[1], /opencode.*--session.*ses_2aB3cD4eF5gH6jK7/);
  assert.strictEqual(launches[0].opts.cwd, "/safe/project");
});

test("Antigravity retained sessions prefer the matching Desktop conversation", async () => {
  const navigated = [];
  const desktopDir = path.join("/safe/home", ".gemini", "antigravity", "brain", ANTIGRAVITY_ID);
  const result = await resumeRetainedSession(retained(
    "antigravity-cli",
    `antigravity:${ANTIGRAVITY_ID}`
  ), {
    osPlatform: "darwin",
    homeDir: "/safe/home",
    statSync: (value) => {
      if (value === desktopDir || value === "/safe/project") return directoryStat();
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    navigateAntigravityConversation: async (id) => { navigated.push(id); },
  });

  assert.deepStrictEqual(result, { status: "ok", action: "open-antigravity-conversation" });
  assert.deepStrictEqual(navigated, [ANTIGRAVITY_ID]);
  assert.deepStrictEqual(detectAntigravitySurface(ANTIGRAVITY_ID, {
    homeDir: "/safe/home",
    statSync: (value) => {
      if (value === desktopDir) return directoryStat();
      throw new Error("missing");
    },
  }), {
    surface: "desktop",
    desktopAvailable: true,
    cliAvailable: false,
  });
});

test("CLI resume fails safely when the original project directory is gone", async () => {
  const result = await resumeRetainedSession(retained("claude-code", CLAUDE_ID), {
    statSync: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    launchClaudeSession: async () => { throw new Error("must not launch"); },
  });
  assert.deepStrictEqual(result, { status: "error", reason: "working-directory-unavailable" });
});
