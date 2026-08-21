# Yueh custom update runbook

This file is the project-local source of truth for maintaining Yueh's Clawd build.

## Stable layout

- `origin`: `https://github.com/Yueh-H/clawd-on-desk.git`
- `upstream`: `https://github.com/rullerzhou-afk/clawd-on-desk.git`
- Custom branch: `codex/yueh-custom`
- Active custom checkout: `/Users/jenyueh/tools/clawd-on-desk-agent-dashboard`
- Legacy dirty checkout: `/Users/jenyueh/tools/clawd-on-desk` (do not update or clean automatically)

The source-mode updater pulls `origin/<current-branch>`. It does not merge
`upstream/main`, so upstream releases must pass through the controlled workflow
below before they reach the running app.

## Standard upstream update

1. Confirm the active checkout is on `codex/yueh-custom` and the worktree is clean.
2. Fetch both remotes: `git fetch --prune upstream` and `git fetch --prune origin`.
3. Review the ahead/behind counts and upstream diff before merging.
4. Merge `upstream/main` into `codex/yueh-custom`. Never discard the custom HUD,
   session-focus, or profile-qualified Codex session-key behavior to resolve a conflict.
5. If `package.json` or `package-lock.json` changed, run `npm ci`.
6. Run the focused HUD/focus/session tests, syntax checks, and `git diff --check`.
   Also run the full test suite; a failure is acceptable only when the same failure is
   reproduced from a clean `upstream/main` checkout and documented as an upstream baseline.
7. Render the Session HUD and verify: the configured visible-row limit (default 24), idle rows hidden by default while actionable waiting rows remain, longer titles, agent labels,
   right-side status/usage chips, and double-click focus. A Codex row must open the
   matching Codex task; a Claude Desktop-launched Claude Code row must open the
   matching Claude code session. An unmapped Claude Code row must fall back to its
   source terminal/app instead of importing or guessing a conversation.
8. Commit the merge or conflict resolution, push `origin/codex/yueh-custom`, verify the
   remote commit, then relaunch Clawd from the active custom checkout.

## Safety rules

- Do not install the official packaged app over the custom source build; its updater
  targets the original repository and can remove custom UI behavior.
- Do not run updater operations from the legacy dirty checkout.
- Do not stage `*.bak*`, force-push, or hide a failed validation.
- Claude's exact-session jump intentionally resolves `cliSessionId` through Claude
  Desktop's local `claude-code-sessions` metadata before opening its `epitaxy` deep
  link. If a Claude Desktop update changes either contract, keep terminal fallback
  working and revalidate the route; do not replace it with `claude://resume`, which
  can import a duplicate session.
- Dynamic Session Focus & Keypad HTTP Bridge:
  - Added `/focus?index=0..5` and `/dashboard` HTTP GET endpoints in `src/server.js`.
  - Added `focusSessionByIndex(index)` in `src/main.js` which queries `_state.buildSessionSnapshot()` for the active HUD order.
  - Keep macOS generic focus on the established `open <bundle>` path; only fall
    back to System Events when bundle resolution or `open` fails. Do not add an
    unconditional AppleScript activation after a successful `open`.
  - KeySilk 12-key hardware (`Keyslik_configured.ckf`) maps Key 1~6 to `Option + 1~6` and Key 10 to `Option + K`, bridged by Hammerspoon (`~/.hammerspoon/init.lua`) into the local HTTP endpoints silently.
- Shortcut portability:
  - Cross-platform defaults use Electron's `CommandOrControl` (`⌘` on macOS,
    `Ctrl` on Windows/Linux).
  - A physical macOS Control key is stored as `Control` and rendered as `⌃`;
    Windows/Linux Ctrl recording remains `CommandOrControl`.
  - Keep both `CommandOrControl` and physical `Control` variants of common
    destructive/global editing combinations on the reserved-shortcut list.
- If an upstream conflict changes runtime behavior, stop before push until the custom
  behavior is restored and revalidated.
