"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  buildStateBody,
  grokSessionSummaryPath,
  normalizeGrokSessionId,
  readGrokActiveSessionPid,
  readGrokSessionMetadata,
  resolveGrokEvent,
  run,
  stateForGrokEvent,
} = require("../hooks/grok-hook");
const { isGrokCompatibilityInvocation } = require("../hooks/clawd-hook");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-grok-hook-"));
}

describe("Grok native hook", () => {
  it("normalizes Grok wire events and namespaces real session ids", () => {
    assert.strictEqual(resolveGrokEvent({ hookEventName: "user_prompt_submit" }), "UserPromptSubmit");
    assert.strictEqual(resolveGrokEvent({}, "PreToolUse"), "PreToolUse");
    assert.strictEqual(normalizeGrokSessionId("abc-123"), "grok:abc-123");
    assert.strictEqual(normalizeGrokSessionId("grok:abc-123"), "grok:abc-123");
  });

  it("reads only bounded summary metadata for title and model", () => {
    const homeDir = tempHome();
    try {
      const cwd = "/tmp/My Project";
      const sessionId = "01abc-def";
      const summaryPath = grokSessionSummaryPath(cwd, sessionId, { homeDir });
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(summaryPath, JSON.stringify({
        generated_title: "Investigate Grok HUD routing",
        current_model_id: "grok-4.6",
        last_turn_summary: "must not be forwarded",
      }));

      assert.deepStrictEqual(readGrokSessionMetadata(cwd, sessionId, { homeDir }), {
        sessionTitle: "Investigate Grok HUD routing",
        model: "grok-4.6",
      });
      const body = buildStateBody("UserPromptSubmit", {
        sessionId,
        cwd,
        prompt: "<user_query>",
        promptId: "prompt-a",
      }, () => ({}), { homeDir, env: {} });
      assert.strictEqual(body.agent_id, "grok");
      assert.strictEqual(body.session_id, "grok:01abc-def");
      assert.strictEqual(body.session_title, "Investigate Grok HUD routing");
      assert.strictEqual(body.model, "grok-4.6");
      assert.strictEqual(body.grok_prompt_id, "prompt-a");
      assert.strictEqual(body.hook_source, "grok-native");
      assert.ok(!Object.prototype.hasOwnProperty.call(body, "prompt"));
      assert.ok(!Object.values(body).includes("<user_query>"));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses reserved Grok env identity and never falls back to a default session", () => {
    const body = buildStateBody("SessionStart", { cwd: "/tmp/repo" }, () => ({}), {
      env: { GROK_SESSION_ID: "env-session" },
    });
    assert.strictEqual(body.session_id, "grok:env-session");
    assert.strictEqual(buildStateBody("SessionStart", { cwd: "/tmp/repo" }, () => ({}), { env: {} }), null);
  });

  it("maps an exact live Grok session id and cwd to its active process", () => {
    const homeDir = tempHome();
    try {
      const activeSessionsPath = path.join(homeDir, ".grok", "active_sessions.json");
      fs.mkdirSync(path.dirname(activeSessionsPath), { recursive: true });
      fs.writeFileSync(activeSessionsPath, JSON.stringify([
        { session_id: "sid-a", pid: process.pid, cwd: "/tmp/a" },
        { session_id: "sid-b", pid: process.pid, cwd: "/tmp/b" },
      ]));
      assert.strictEqual(readGrokActiveSessionPid("sid-a", "/tmp/a", { homeDir }), process.pid);
      assert.strictEqual(readGrokActiveSessionPid("sid-a", "/tmp/b", { homeDir }), null);
      assert.strictEqual(readGrokActiveSessionPid("missing", "/tmp/a", { homeDir }), null);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("ships focus metadata only after the process walk verifies Grok", () => {
    const payload = { sessionId: "sid-a", cwd: "/tmp/repo" };
    const unverified = buildStateBody("SessionStart", payload, () => ({
      stablePid: 123,
      agentPid: null,
      pidChain: [456, 123],
    }), { env: {} });
    assert.ok(!Object.prototype.hasOwnProperty.call(unverified, "source_pid"));
    assert.ok(!Object.prototype.hasOwnProperty.call(unverified, "pid_chain"));

    const verified = buildStateBody("SessionStart", payload, () => ({
      stablePid: 123,
      agentPid: 456,
      pidChain: [456, 123],
    }), { env: {} });
    assert.strictEqual(verified.source_pid, 123);
    assert.strictEqual(verified.agent_pid, 456);
    assert.deepStrictEqual(verified.pid_chain, [456, 123]);
  });

  it("filters child events and non-turn Stop events", () => {
    assert.strictEqual(stateForGrokEvent("Stop", { subagentType: "explore", reason: "end_turn" }), null);
    assert.strictEqual(stateForGrokEvent("SessionEnd", { subagentType: "explore" }), null);
    assert.strictEqual(stateForGrokEvent("Stop", { reason: "shutdown" }), null);
    assert.strictEqual(stateForGrokEvent("Stop", { reason: "end_turn", stopHookActive: true }), null);
    assert.strictEqual(stateForGrokEvent("Stop", { reason: "end_turn" }), "attention");
  });

  it("maps idle/task notifications to attention and permission prompts to notification", () => {
    assert.strictEqual(stateForGrokEvent("Notification", { notificationType: "idle_prompt" }), "attention");
    assert.strictEqual(stateForGrokEvent("Notification", { notificationType: "task_complete" }), "attention");
    assert.strictEqual(stateForGrokEvent("Notification", { notificationType: "permission_prompt" }), "notification");
  });

  it("posts a state-only payload and always returns a fail-open object", async () => {
    let posted = null;
    const result = await run({
      sessionId: "sid-a",
      cwd: "/tmp/repo",
      promptId: "turn-a",
    }, "UserPromptSubmit", {
      env: {},
      resolvePid: () => ({}),
      postState: (json, _options, callback) => {
        posted = JSON.parse(json);
        callback(true, 23335);
      },
    });
    assert.strictEqual(result.stdout, "{}");
    assert.strictEqual(result.posted, true);
    assert.strictEqual(posted.agent_id, "grok");
    assert.strictEqual(posted.session_id, "grok:sid-a");
    assert.strictEqual(posted.state, "thinking");
  });

  it("recognizes Grok's Claude-compatibility invocation provenance", () => {
    assert.strictEqual(isGrokCompatibilityInvocation({ GROK_SESSION_ID: "sid" }), true);
    assert.strictEqual(isGrokCompatibilityInvocation({ GROK_HOOK_EVENT: "Stop" }), true);
    assert.strictEqual(isGrokCompatibilityInvocation({}), false);
  });

  it("makes imported Claude and Cursor Clawd hooks immediate no-ops", () => {
    for (const [script, event] of [["clawd-hook.js", "SessionStart"], ["cursor-hook.js", "sessionStart"]]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "..", "hooks", script), event], {
        input: JSON.stringify({ sessionId: "grok-session" }),
        encoding: "utf8",
        env: {
          ...process.env,
          GROK_SESSION_ID: "grok-session",
          GROK_HOOK_EVENT: event,
        },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), "{}");
    }
  });
});
