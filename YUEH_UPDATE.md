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
7. Render the Session HUD and verify: eight visible rows, longer titles, agent labels,
   right-side status/usage chips, and double-click focus.
8. Commit the merge or conflict resolution, push `origin/codex/yueh-custom`, verify the
   remote commit, then relaunch Clawd from the active custom checkout.

## Safety rules

- Do not install the official packaged app over the custom source build; its updater
  targets the original repository and can remove custom UI behavior.
- Do not run updater operations from the legacy dirty checkout.
- Do not stage `*.bak*`, force-push, or hide a failed validation.
- If an upstream conflict changes runtime behavior, stop before push until the custom
  behavior is restored and revalidated.
