// Grok CLI agent configuration
// Native global hooks are loaded from ~/.grok/hooks/*.json.

module.exports = {
  id: "grok",
  name: "Grok CLI",
  processNames: { win: ["grok.exe"], mac: ["grok"], linux: ["grok"] },
  startupRecoveryProcessNames: { win: ["grok.exe"], mac: ["grok"], linux: ["grok"] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    PermissionDenied: "notification",
    Stop: "attention",
    StopFailure: "error",
    StopCancelled: "attention",
    Notification: "notification",
    PreCompact: "sweeping",
    PostCompact: "thinking",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "grok-hooks-json",
  },
  stdinFormat: "grokHookJson",
  pidField: "agent_pid",
};
