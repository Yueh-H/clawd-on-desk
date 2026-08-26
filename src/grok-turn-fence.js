"use strict";

const MAX_TRACKED_PROMPTS = 32;
const MAX_TRACKED_SESSIONS = 256;

function createGrokTurnFence(options = {}) {
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const sessions = new Map();

  function entryFor(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      while (sessions.size >= MAX_TRACKED_SESSIONS) {
        sessions.delete(sessions.keys().next().value);
      }
      entry = { activePromptId: null, seen: new Set(), settled: new Set() };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  function remember(set, value) {
    if (!value) return;
    set.delete(value);
    set.add(value);
    while (set.size > MAX_TRACKED_PROMPTS) set.delete(set.values().next().value);
  }

  function reject(sessionId, event, promptId, reason) {
    debugLog(`grok-turn-fence sid=${sessionId} event=${event} prompt=${promptId || "-"} drop=${reason}`);
    return { accept: false, reason };
  }

  function observe({ sessionId, event, promptId, notificationType }) {
    if (!sessionId || !event) return { accept: true, reason: "unscoped" };
    if (event === "SessionStart") {
      sessions.delete(sessionId);
      return { accept: true, reason: "session-start" };
    }
    if (event === "SessionEnd") {
      sessions.delete(sessionId);
      return { accept: true, reason: "session-end" };
    }

    const entry = entryFor(sessionId);
    if (event === "UserPromptSubmit") {
      if (!promptId) return { accept: true, reason: "prompt-without-id" };
      if (entry.activePromptId && entry.activePromptId !== promptId) {
        remember(entry.settled, entry.activePromptId);
      }
      entry.activePromptId = promptId;
      remember(entry.seen, promptId);
      entry.settled.delete(promptId);
      return { accept: true, reason: "newest-prompt" };
    }

    const isTurnEnd = event === "Stop" || event === "StopFailure" || event === "StopCancelled";
    const isUnscopedSettlement = event === "Notification"
      && !promptId
      && (notificationType === "idle_prompt" || notificationType === "task_complete");
    if (isUnscopedSettlement) {
      if (entry.activePromptId) remember(entry.settled, entry.activePromptId);
      entry.activePromptId = null;
      return { accept: true, reason: "session-settlement" };
    }

    if (promptId && entry.activePromptId && promptId !== entry.activePromptId) {
      return reject(sessionId, event, promptId, "older-than-active-prompt");
    }
    if (promptId && entry.settled.has(promptId)) {
      return reject(sessionId, event, promptId, "already-settled-prompt");
    }

    if (isTurnEnd) {
      if (promptId) {
        remember(entry.seen, promptId);
        remember(entry.settled, promptId);
      } else if (entry.activePromptId) {
        remember(entry.settled, entry.activePromptId);
      }
      entry.activePromptId = null;
      return { accept: true, reason: promptId ? "turn-settled" : "unscoped-turn-settled" };
    }

    if (promptId) {
      remember(entry.seen, promptId);
      if (!entry.activePromptId) entry.activePromptId = promptId;
    }
    return { accept: true, reason: "current-activity" };
  }

  return {
    observe,
    clear: (sessionId) => sessions.delete(sessionId),
    clearAll: () => sessions.clear(),
    size: () => sessions.size,
  };
}

module.exports = createGrokTurnFence;
