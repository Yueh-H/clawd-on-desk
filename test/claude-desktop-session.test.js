"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DESKTOP_RECORD_MAX_BYTES,
  buildClaudeDesktopSessionUrl,
  findClaudeDesktopSession,
  hasClaudeTranscriptFile,
  hasStoredClaudeSessionEvidence,
} = require("../src/claude-desktop-session");

const CLI_ID = "be45d95f-b282-4d03-95f1-c8898811fd23";
const LOCAL_ID = "local_0689e98a-f9fe-415f-ae98-2bf3184f47bb";
const OTHER_LOCAL_ID = "local_c778b311-0f19-41b7-a112-3bd60754a2c4";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeDesktopRecord(root, sessionId, record) {
  const dir = path.join(root, "account", "organization");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ sessionId, ...record }));
}

test("Claude Desktop records map a CLI session to an exact existing app route", () => {
  const root = makeTempDir("clawd-claude-desktop-");
  try {
    writeDesktopRecord(root, LOCAL_ID, {
      cliSessionId: CLI_ID,
      cwd: "/safe/project",
      title: "Existing desktop task",
      lastActivityAt: "2026-08-26T01:00:00.000Z",
    });
    assert.deepStrictEqual(findClaudeDesktopSession(CLI_ID, {
      desktopSessionRoot: root,
      cwd: "/safe/project",
    }), {
      sessionId: LOCAL_ID,
      cliSessionId: CLI_ID,
      isArchived: false,
      lastActivityAt: Date.parse("2026-08-26T01:00:00.000Z"),
    });
    assert.strictEqual(
      buildClaudeDesktopSessionUrl(LOCAL_ID),
      `claude://claude.ai/epitaxy/${LOCAL_ID}`
    );
    assert.strictEqual(buildClaudeDesktopSessionUrl("../../unsafe"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Desktop mapping prefers a non-archived matching-project record", () => {
  const root = makeTempDir("clawd-claude-desktop-rank-");
  try {
    writeDesktopRecord(root, LOCAL_ID, {
      cliSessionId: CLI_ID,
      cwd: "/other/project",
      title: "Newer but wrong project",
      lastActivityAt: "2026-08-26T03:00:00.000Z",
    });
    writeDesktopRecord(root, OTHER_LOCAL_ID, {
      cliSessionId: CLI_ID,
      cwd: "/safe/project",
      title: "Exact project",
      lastActivityAt: "2026-08-26T02:00:00.000Z",
    });
    assert.strictEqual(findClaudeDesktopSession(CLI_ID, {
      desktopSessionRoot: root,
      cwd: "/safe/project",
    }).sessionId, OTHER_LOCAL_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Desktop mapping ignores malformed, oversized, and symlink records", () => {
  const root = makeTempDir("clawd-claude-desktop-safe-");
  try {
    const dir = path.join(root, "account", "organization");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${LOCAL_ID}.json`), "{not-json");
    fs.writeFileSync(
      path.join(dir, `${OTHER_LOCAL_ID}.json`),
      " ".repeat(DESKTOP_RECORD_MAX_BYTES + 1)
    );
    const mismatchedId = "local_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    fs.writeFileSync(
      path.join(dir, `${mismatchedId}.json`),
      JSON.stringify({ sessionId: LOCAL_ID, cliSessionId: CLI_ID })
    );
    const target = path.join(root, "outside.json");
    fs.writeFileSync(target, JSON.stringify({ sessionId: LOCAL_ID, cliSessionId: CLI_ID }));
    const symlinkId = "local_ffffffff-ffff-4fff-afff-ffffffffffff";
    fs.symlinkSync(target, path.join(dir, `${symlinkId}.json`));
    assert.strictEqual(findClaudeDesktopSession(CLI_ID, { desktopSessionRoot: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude transcript evidence accepts direct and first-level project files only", () => {
  const root = makeTempDir("clawd-claude-transcript-");
  try {
    const direct = path.join(root, "direct.jsonl");
    fs.writeFileSync(direct, "{}\n");
    assert.strictEqual(hasClaudeTranscriptFile({ rawSessionId: CLI_ID, transcriptPath: direct }), true);

    const projectsRoot = path.join(root, "projects");
    const projectDir = path.join(projectsRoot, "-safe-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${CLI_ID}.jsonl`), "{}\n");
    assert.strictEqual(hasStoredClaudeSessionEvidence({ rawSessionId: CLI_ID }, {
      desktopSessionRoot: path.join(root, "missing-desktop"),
      projectsRoot,
    }), true);
    assert.strictEqual(hasStoredClaudeSessionEvidence({
      rawSessionId: "ffffffff-ffff-4fff-afff-ffffffffffff",
    }, {
      desktopSessionRoot: path.join(root, "missing-desktop"),
      projectsRoot,
    }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
