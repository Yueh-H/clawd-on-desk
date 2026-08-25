"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createManualSessionRetentionStore,
} = require("../src/manual-session-retention");

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-retained-sessions-"));
  return { dir, persistPath: path.join(dir, "retained-sessions.json") };
}

test("manual retention persists only sanitized display metadata", () => {
  const { dir, persistPath } = makeTempStore();
  try {
    const store = createManualSessionRetentionStore({ persistPath });
    assert.strictEqual(store.upsertSession("session-1", {
      agentId: "codex",
      profileId: "local",
      rawSessionId: "raw-1",
      sessionTitle: "Build dashboard",
      cwd: "/tmp/project  with spaces",
      updatedAt: 1234,
      sourcePid: 999,
      agentPid: 1000,
      transcriptPath: "/secret/transcript.jsonl",
      assistantLastOutput: "private answer",
      sessionAutomationIdentity: { eligible: true },
      contextUsage: { used: 123 },
      recentEvents: [{ event: "Stop" }],
    }), true);
    assert.strictEqual(store.flush(), true);

    const persistedText = fs.readFileSync(persistPath, "utf8");
    const persisted = JSON.parse(persistedText);
    assert.strictEqual(persisted.version, 1);
    assert.deepStrictEqual(persisted.sessions[0], {
      id: "session-1",
      profileId: "local",
      rawSessionId: "raw-1",
      agentId: "codex",
      sessionTitle: "Build dashboard",
      cwd: "/tmp/project  with spaces",
      updatedAt: 1234,
      host: null,
      wslDistro: null,
      platform: null,
      model: null,
      provider: null,
      codexOriginator: null,
      codexSource: null,
    });
    for (const secret of ["private answer", "transcript.jsonl", "sourcePid", "recentEvents", "contextUsage"]) {
      assert.strictEqual(persistedText.includes(secret), false, `${secret} must not be persisted`);
    }
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(persistPath).mode & 0o777, 0o600);
    }

    const restored = createManualSessionRetentionStore({ persistPath });
    const historical = restored.historicalSessions().get("session-1");
    assert.strictEqual(historical.state, "idle");
    assert.strictEqual(historical.manualRetained, true);
    assert.strictEqual(historical.sourcePid, null);
    assert.strictEqual(historical.requiresCompletionAck, false);
    assert.deepStrictEqual(historical.recentEvents, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("manual retention removes a card durably", () => {
  const { dir, persistPath } = makeTempStore();
  try {
    const store = createManualSessionRetentionStore({ persistPath });
    store.upsertSession("session-1", { agentId: "claude-code", cwd: "/tmp" });
    store.flush();
    assert.strictEqual(store.remove("session-1"), true);
    assert.strictEqual(store.remove("session-1"), false);
    store.flush();

    const restored = createManualSessionRetentionStore({ persistPath });
    assert.deepStrictEqual(restored.listRecords(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
