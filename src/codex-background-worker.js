"use strict";

const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

const CLAUDE_BASH_CODEX_SOURCES = new Set(["startup", "exec", "cli"]);
const CLAUDE_SCRATCHPAD_CWD_RE = /^\/(?:private\/)?tmp\/claude-\d+\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad(?:\/|$)/i;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isClaudeScratchpadCwd(value) {
  const cwd = normalizeText(value).replace(/\\/g, "/");
  return CLAUDE_SCRATCHPAD_CWD_RE.test(cwd);
}

// Claude Code's Bash tool can launch one or many `codex exec --ephemeral`
// workers inside its private scratchpad. Codex reports those child processes
// as ordinary root CLI sessions (source=startup/exec) without a parent-session
// marker, so the normal subagent classifier cannot hide them. The scratchpad
// path is the missing ownership evidence: keep those batch workers headless
// while preserving normal Terminal-launched Codex sessions everywhere else.
function isClaudeBashCodexWorkerSession(session) {
  if (!session || session.agentId !== "codex") return false;
  const host = normalizeText(session.host).toLowerCase();
  if (host && host !== "local") return false;
  if (isCodexDesktopOriginator(session.codexOriginator)) return false;

  const source = normalizeText(session.codexSource).toLowerCase();
  if (!CLAUDE_BASH_CODEX_SOURCES.has(source)) return false;
  return isClaudeScratchpadCwd(session.cwd);
}

module.exports = {
  CLAUDE_SCRATCHPAD_CWD_RE,
  isClaudeBashCodexWorkerSession,
  isClaudeScratchpadCwd,
};
