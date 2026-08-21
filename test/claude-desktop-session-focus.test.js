"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeSessionKey } = require("../src/session-key");

const {
  buildClaudeDesktopSessionUrl,
  createClaudeDesktopSessionResolver,
  focusClaudeDesktopSessionTarget,
  getClaudeCliSessionId,
  getDefaultClaudeDesktopMetadataRoot,
  scanClaudeDesktopSessionMetadata,
} = require("../src/claude-desktop-session-focus");

const CLI_SESSION_ID = "86eb6070-8461-4723-8626-20e8870d3dea";
const OTHER_CLI_SESSION_ID = "821ee6b2-6228-4644-959a-808e578277ae";
const LOCAL_SESSION_ID = "local_42d110d8-51c7-4e90-a7d7-00ba98a9fb67";
const OTHER_LOCAL_SESSION_ID = "local_ea85bb11-28d1-4388-87c5-1afc88f79c55";

function createMetadataFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-session-focus-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountDir = path.join(root, "org-id", "account-id");
  fs.mkdirSync(accountDir, { recursive: true });
  return { root, accountDir };
}

function writeMetadata(accountDir, localSessionId, cliSessionId, overrides = {}) {
  const metadata = {
    sessionId: localSessionId,
    cliSessionId,
    title: "Fixture session",
    ...overrides,
  };
  fs.writeFileSync(
    path.join(accountDir, `${localSessionId}.json`),
    JSON.stringify(metadata),
  );
}

describe("Claude Desktop session identity", () => {
  it("extracts raw and profile-qualified Claude Code CLI session IDs", () => {
    assert.strictEqual(getClaudeCliSessionId({
      id: CLI_SESSION_ID,
      agentId: "claude-code",
    }), CLI_SESSION_ID);
    assert.strictEqual(getClaudeCliSessionId({
      id: makeSessionKey({ profileId: "local", rawSessionId: CLI_SESSION_ID }),
      agentId: "claude-code",
    }), CLI_SESSION_ID);
    assert.strictEqual(getClaudeCliSessionId({
      id: CLI_SESSION_ID,
      agentId: "codex",
    }), null);
    assert.strictEqual(getClaudeCliSessionId({
      id: CLI_SESSION_ID,
      agentId: "claude-code",
      host: "remote-box",
    }), null);
  });

  it("builds only validated Claude Desktop local-session deep links", () => {
    assert.strictEqual(
      buildClaudeDesktopSessionUrl(LOCAL_SESSION_ID),
      `claude://claude.ai/epitaxy/${LOCAL_SESSION_ID}`,
    );
    assert.strictEqual(buildClaudeDesktopSessionUrl(CLI_SESSION_ID), null);
    assert.strictEqual(buildClaudeDesktopSessionUrl("local_not-a-uuid"), null);
    assert.strictEqual(
      getDefaultClaudeDesktopMetadataRoot({ platform: "darwin", homeDir: "/Users/test" }),
      "/Users/test/Library/Application Support/Claude/claude-code-sessions",
    );
    assert.strictEqual(getDefaultClaudeDesktopMetadataRoot({ platform: "linux" }), null);
  });
});

describe("Claude Desktop metadata resolver", () => {
  it("maps a Claude Code CLI UUID to its unique local Claude Desktop session", (t) => {
    const { root, accountDir } = createMetadataFixture(t);
    writeMetadata(accountDir, LOCAL_SESSION_ID, CLI_SESSION_ID);
    writeMetadata(accountDir, OTHER_LOCAL_SESSION_ID, OTHER_CLI_SESSION_ID);

    const sessions = scanClaudeDesktopSessionMetadata({ metadataRoot: root });
    assert.strictEqual(sessions.get(CLI_SESSION_ID), LOCAL_SESSION_ID);

    const resolve = createClaudeDesktopSessionResolver({
      metadataRoot: root,
      now: () => 100,
    });
    assert.deepStrictEqual(resolve({
      id: CLI_SESSION_ID,
      agentId: "claude-code",
    }), {
      cliSessionId: CLI_SESSION_ID,
      localSessionId: LOCAL_SESSION_ID,
      url: `claude://claude.ai/epitaxy/${LOCAL_SESSION_ID}`,
    });
  });

  it("rejects malformed, mismatched, oversized, and ambiguous metadata", (t) => {
    const { root, accountDir } = createMetadataFixture(t);
    fs.writeFileSync(path.join(accountDir, `${LOCAL_SESSION_ID}.json`), "{bad json");
    writeMetadata(accountDir, OTHER_LOCAL_SESSION_ID, CLI_SESSION_ID, {
      sessionId: LOCAL_SESSION_ID,
    });

    const thirdLocalSessionId = "local_682767f5-13a3-46b8-bfaf-cffd363a3026";
    writeMetadata(accountDir, thirdLocalSessionId, OTHER_CLI_SESSION_ID, {
      padding: "x".repeat(2048),
    });
    assert.strictEqual(scanClaudeDesktopSessionMetadata({
      metadataRoot: root,
      maxMetadataBytes: 512,
    }).size, 0);

    writeMetadata(accountDir, LOCAL_SESSION_ID, CLI_SESSION_ID);
    writeMetadata(accountDir, OTHER_LOCAL_SESSION_ID, CLI_SESSION_ID);
    const sessions = scanClaudeDesktopSessionMetadata({ metadataRoot: root });
    assert.strictEqual(sessions.has(CLI_SESSION_ID), false);
  });

  it("refreshes negative results after the bounded cache expires", (t) => {
    const { root, accountDir } = createMetadataFixture(t);
    let now = 100;
    const resolve = createClaudeDesktopSessionResolver({
      metadataRoot: root,
      now: () => now,
      cacheTtlMs: 50,
    });
    const entry = { id: CLI_SESSION_ID, agentId: "claude-code" };

    assert.strictEqual(resolve(entry), null);
    writeMetadata(accountDir, LOCAL_SESSION_ID, CLI_SESSION_ID);
    assert.strictEqual(resolve(entry), null);
    now = 151;
    assert.strictEqual(resolve(entry).localSessionId, LOCAL_SESSION_ID);
  });
});

describe("Claude Desktop focus handoff", () => {
  it("opens the exact Claude Desktop session and logs success", async () => {
    const opened = [];
    const logs = [];
    const entry = { id: CLI_SESSION_ID, agentId: "claude-code", sourcePid: 123 };

    await focusClaudeDesktopSessionTarget({
      shell: { openExternal: async (url) => opened.push(url) },
      focusEntry: entry,
      sessionId: CLI_SESSION_ID,
      requestSource: "hud",
      resolveClaudeDesktopSession: () => ({
        cliSessionId: CLI_SESSION_ID,
        localSessionId: LOCAL_SESSION_ID,
        url: `claude://claude.ai/epitaxy/${LOCAL_SESSION_ID}`,
      }),
      focusLog: (line) => logs.push(line),
    });

    assert.deepStrictEqual(opened, [`claude://claude.ai/epitaxy/${LOCAL_SESSION_ID}`]);
    assert.ok(logs.some((line) => line.includes("target=claude-desktop-session")));
    assert.ok(logs.some((line) => line.includes("reason=opened")));
  });

  it("returns control to terminal focus when metadata is missing", () => {
    const logs = [];
    const result = focusClaudeDesktopSessionTarget({
      shell: { openExternal: async () => {} },
      focusEntry: { id: CLI_SESSION_ID, agentId: "claude-code", sourcePid: 123 },
      resolveClaudeDesktopSession: () => null,
      focusLog: (line) => logs.push(line),
    });

    assert.strictEqual(result, null);
    assert.ok(logs.some((line) => line.includes("reason=metadata-not-found")));
  });

  it("falls back to the source app when the Claude deep link fails", async () => {
    const logs = [];
    const terminalCalls = [];
    const entry = { id: CLI_SESSION_ID, agentId: "claude-code", sourcePid: 123 };

    await focusClaudeDesktopSessionTarget({
      shell: {
        openExternal: async () => {
          throw new Error("protocol failed\nwith tab");
        },
      },
      focusEntry: entry,
      sessionId: CLI_SESSION_ID,
      requestSource: "dashboard",
      resolveClaudeDesktopSession: () => ({
        cliSessionId: CLI_SESSION_ID,
        localSessionId: LOCAL_SESSION_ID,
        url: `claude://claude.ai/epitaxy/${LOCAL_SESSION_ID}`,
      }),
      focusLog: (line) => logs.push(line),
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.deepStrictEqual(terminalCalls, [[entry, CLI_SESSION_ID, "dashboard"]]);
    assert.ok(logs.some((line) =>
      line.includes("reason=open-failed") && line.includes("protocol failed with tab")
    ));
  });
});
