# Issue #882 Windows ARM64 Upgrade Investigation

Status: Mac-side preparation complete; Windows reproduction pending.

This document is a reproduction and evidence plan, not a production fix. Issue #882 reports a current-user v0.14.0 to v0.15.0 ARM64 upgrade failure from the custom path `C:\FormerD\Programs\Clawd on Desk`. No GitHub reply or product change should be based on this plan alone.

## What the current code proves

- `build/installer.nsh` is identical in v0.14.0, v0.15.0, and current main.
- electron-builder runs the old uninstaller before installing the new payload.
- The old uninstaller runs Clawd's `customUnInstall` before its updated-install atomic removal.
- That macro launches the installed `Clawd on Desk.exe` as Node and then PowerShell from the directory about to be removed. Their exit codes are discarded.
- In updated mode, electron-builder recursively renames each old file from `$INSTDIR` to `$PLUGINSDIR\old-install`. One failed rename restores the files and aborts.
- The new installer retries every non-zero old-uninstaller result five times and then reports `appCannotBeClosed`, even when the failure was not caused by a running app.
- A normal manual uninstall instead runs unchecked `RMDir /r` and then deletes the uninstall registry keys. It can therefore exit successfully with the registry gone while files remain.

The first failed path and Windows error are not yet known. Two live hypotheses remain:

1. `C:\FormerD` is a mount point or junction whose target is on a different underlying volume from `%TEMP%`. Windows cannot rename files across volumes, so atomic removal would fail deterministically.
2. One of the cleanup processes launched from `$INSTDIR`, or a child it leaves behind briefly, still holds the first file that atomic removal tries to rename.

The observer records the volume GUID, reparse chain, process lifecycle, tree summary, and uninstall registry state needed to distinguish them. Procmon supplies the first failed file operation.

## Safety boundary

The observer is read-only except for its explicit evidence output. It does not start or stop the target installer/app processes, close Clawd, edit the registry, remove files, create links, or alter proxy/network settings. Its evidence parent directory must already exist, have no reparse-point ancestor, and be outside the install tree; an existing JSON file is never overwritten.

Installing v0.14.0, running an upgrade, loading Procmon, and creating a junction are mutating steps. Run them only in a disposable Windows VM or a dedicated test account with a recoverable snapshot. Never use broad process cleanup: Windows Terminal, Codex, `cmd.exe`, `ssh.exe`, OpenConsole, and conhost may be shared with unrelated work.

## Minimum reproduction matrix

All rows use Windows 11 ARM64, the official v0.14.0 ARM64 current-user installer, and the same candidate ARM64 installer.

| Case | v0.14.0 install directory | Topology | Relation to observer `%TEMP%` | Launch context | Purpose |
|---|---|---|---|---|---|
| A | Default current-user path | Plain directory | Same underlying volume | Normal user | Baseline |
| B | `C:\Clawd882\Plain\Clawd on Desk` | Plain custom directory | Same underlying volume | Normal user | Separate custom path from volume boundary |
| C | `D:\Clawd882\Plain\Clawd on Desk` | Plain custom directory | Different underlying volume | Normal user | Direct cross-volume test |
| D | `C:\Clawd882\CrossLink\Clawd on Desk` targeting D | Junction/mount path | Different underlying volume | Normal user | Closest controlled analogue to `C:\FormerD` |
| E | Restored snapshot of failing C or D | Same as failed row | Different underlying volume | Observer and candidate both elevated via split token, same SID/session | Separate elevation from volume boundary |

If D fails but C passes, add a same-volume `C:` to `C:` junction control. If no second real volume exists, mark C/D pending rather than creating a VHD on a busy host.

The official v0.14.0 ARM64 installer expected SHA-256 is:

```text
0e4d6527603a924394697ccb0648b09c146a5c39f8bd725c481d4bbca0177a42
```

Record the candidate hash and Authenticode status separately for every run.

## Observer run

After installing v0.14.0 and exiting Clawd through its own menu, verify that no process whose executable path is inside the exact test install directory remains. Do not kill anything by name.

Start the observer from a separate PowerShell window, with its output outside the install tree:

```powershell
& .\scripts\manual\issue-882-windows-upgrade-observe.ps1 `
  -InstallDir 'D:\Clawd882\Plain\Clawd on Desk' `
  -SetupPath 'C:\Clawd882\artifacts\Clawd-on-Desk-Setup-CANDIDATE-arm64.exe' `
  -OutputPath 'C:\Clawd882\evidence\case-C.json' `
  -DurationSeconds 180
```

While it is sampling, trigger exactly one upgrade attempt. The observer does not launch the installer. If the final Retry/Cancel dialog appears, capture it, click Cancel once while the observer is still running, and do not enter another Retry loop. This lets the JSON contain both the after-each-old-uninstaller transaction snapshots and the candidate setup exit event. Do not otherwise change the install tree or registry until the observer finishes.

The most important JSON fields are:

- `paths.sameInstallAndObserverTempVolume`, plus both `volumeName` values;
- `paths.installPathChainBefore[*].isReparsePoint`, `linkType`, and `targets`;
- each captured `old-uninstaller.exe` process `executableVolume`; unlike observer TEMP, this is the actual plugin-directory volume proxy;
- `processEvents` for Setup and `old-uninstaller.exe` start/stop, `exitStatusAvailable`, decimal `exitStatus`, and hexadecimal `exitStatusHex`;
- `transactionSnapshots` triggered by each old-uninstaller exit, with separate trigger/capture timestamps; these are approximate O(1) anchor/registry probes and may overlap the next retry, while recursive tree enumeration is reserved for before/final snapshots;
- before/after install tree counts and key file hashes;
- before/after 32-bit and 64-bit install/uninstall registry keys for the exact Clawd app GUID.

`sameInstallAndObserverTempVolume` is a screening field, not root-cause proof: elevation or an environment override can give Setup a different TEMP. The actual old-uninstaller path and Procmon's rename destination are stronger. Do not infer the underlying volume from drive-letter-looking text; a path beginning with `C:\` can enter a mounted D volume below a reparse point.

For the elevated row, start the observer itself from an elevated PowerShell under the same split-token account; otherwise Windows can hide the elevated Setup executable path and the exact-path filter will deliberately reject it. Accept the row only if Setup's captured owner SID/session matches `environment.currentUserSid`/`observerSessionId` and Procmon shows High integrity. Entering another administrator account at UAC invalidates the row. A tree snapshot with `complete=false` is partial evidence and its counts are not a deletion postcondition.

## Procmon evidence

Use the official ARM64 `Procmon64a.exe`. Keep File System, Registry, and Process/Thread events; Network and Profiling are unnecessary. Keep `Drop Filtered Events` disabled so the original PML remains complete.

Include these process names:

- the exact candidate installer filename;
- `old-uninstaller.exe`;
- `Clawd on Desk.exe`;
- `powershell.exe`.

Save Time, Process Name, PID, User, Operation, Path, Result, Detail, Integrity Level, and Command Line. After the failure, preserve the PML first. Then filter `old-uninstaller.exe` to the first rename/delete result that is not success and retain roughly 20 surrounding events.

Evidence supporting the volume hypothesis is the first `SetRenameInformationFile`/rename from the install tree to `$PLUGINSDIR\old-install` failing with `NOT SAME DEVICE` or the equivalent Windows error. A sharing violation on a concrete file instead supports the live-process/file-lock hypothesis.

## Pass and failure gates

A row passes only when all are true. The observer JSON proves the captured process/registry/tree facts; Procmon proves file operations and process integrity; launching the installed app and checking its displayed version remains a human UI step.

- no `appCannotBeClosed` loop;
- installer exit code is zero;
- exactly one correct candidate-version uninstall record remains in the expected user hive;
- the candidate app starts and reports the expected version;
- there is no failed install-tree to `$PLUGINSDIR\old-install` rename;
- the old tree and uninstall registry cannot disagree in a false-success state.

On failure, preserve the PML, screenshot, observer JSON, and installer hashes. Do not manually delete registry keys, overwrite the old directory, or run a second cleanup attempt before saving evidence. Restore the VM snapshot for the next row. If no snapshot exists, preserve that test account and use another dedicated account.

A direct candidate launch with `--updated --force-run` validates the NSIS upgrade transaction but does not validate the built-in updater's download/cache handoff. After the candidate passes the matrix, one real update feed run is still required.

For junction cleanup, remove only the exact link after proving its target. Do not recursively delete a junction or mount path.

## Repair boundary

A fix in the new version's `customUnInstall` does not change the already shipped v0.14.0 uninstaller used during v0.14.0 to candidate upgrades. The candidate may therefore need a narrowly scoped rescue path for a failed old-uninstaller transaction. Do not design that path until Windows evidence identifies the first failure and proves the old tree and registry states that must be recovered.
