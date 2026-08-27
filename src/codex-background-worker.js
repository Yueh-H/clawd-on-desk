"use strict";

const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

const CLAUDE_BASH_CODEX_SOURCES = new Set(["startup", "exec", "cli"]);
const LEGACY_ISOLATED_CODEX_SOURCES = new Set(["", "startup", "exec"]);
const CLAUDE_SCRATCHPAD_CWD_RE = /^\/(?:private\/)?tmp\/claude-\d+\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad(?:\/|$)/i;
const ISOLATED_WORKSPACE_CWD_RE = /(?:^|\/)\.isolated(?:\/|$)/i;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isClaudeScratchpadCwd(value) {
  const cwd = normalizeText(value).replace(/\\/g, "/");
  return CLAUDE_SCRATCHPAD_CWD_RE.test(cwd);
}

function isIsolatedWorkspaceCwd(value) {
  const cwd = normalizeText(value).replace(/\\/g, "/");
  return ISOLATED_WORKSPACE_CWD_RE.test(cwd);
}

// Claude Code's Bash tool can launch one or many `codex exec --ephemeral`
// workers inside its private scratchpad. Codex reports those child processes
// as ordinary root CLI sessions (source=startup/exec) without a parent-session
// marker, so the normal subagent classifier cannot hide them. The scratchpad
// path is the missing ownership evidence: keep those batch workers headless
// while preserving normal Terminal-launched Codex sessions everywhere else.
function isBackgroundCodexWorkerSession(session) {
  if (!session || session.agentId !== "codex") return false;
  const host = normalizeText(session.host).toLowerCase();
  if (host && host !== "local") return false;
  if (isCodexDesktopOriginator(session.codexOriginator)) return false;

  const source = normalizeText(session.codexSource).toLowerCase();
  if (CLAUDE_BASH_CODEX_SOURCES.has(source) && isClaudeScratchpadCwd(session.cwd)) {
    return true;
  }

  // Before Codex hooks tagged `exec --ephemeral` as headless, automation such
  // as heptascan was retained as a root CLI session with no originator and a
  // dedicated `.isolated` work directory. Keep this narrow legacy classifier
  // so those already-persisted cards are pruned on the next Clawd startup.
  return !normalizeText(session.codexOriginator)
    && LEGACY_ISOLATED_CODEX_SOURCES.has(source)
    && isIsolatedWorkspaceCwd(session.cwd);
}

module.exports = {
  CLAUDE_SCRATCHPAD_CWD_RE,
  ISOLATED_WORKSPACE_CWD_RE,
  isBackgroundCodexWorkerSession,
  isClaudeScratchpadCwd,
  isIsolatedWorkspaceCwd,
};
