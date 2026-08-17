Clawd on Desk - Issue #813 diagnostic build 3
================================================

Base: v0.14.0 (commit 86125b9ff72eb3c85ba6e731889a42a6a6b5c006)
Target: Ubuntu/Linux x86_64

This is a diagnostic build, not a release. It does not start Clawd's local
hook/permission server, synchronize integrations, check for updates, connect
Remote SSH, register shortcuts/protocols, or launch the first-run tutorial.
It cannot show or answer coding-agent permission requests; use the agent's
native approval UI instead.

Every launch first checks the Linux process table for another Clawd main
process. A PROCESS-PREFLIGHT BLOCKED line means that no measurement may be
taken from that launch. Each accepted process then uses a fresh temporary
userData directory shown in its START line, so it does not read or update the
installed Clawd preferences or user themes. Those temporary directories are
left for normal operating-system temporary-file cleanup.

Important configuration limitation
----------------------------------

Isolation deliberately gives this build the v0.14.0 default pet configuration,
not the reporter's installed preferences. The CONFIG line records the controlled
theme, size, window bounds and display. This protects user data and makes runs
repeatable, but it also means that a baseline which does not reproduce must not
be used to conclude that the installed configuration is harmless.

Safety setup
------------

1. Quit every installed or diagnostic Clawd instance. The diagnostic will
   refuse to continue if it can see another Clawd main process.
2. Stop coding-agent activity and finish every pending permission request.
3. Keep Settings, Dashboard and every other Clawd auxiliary window closed.
4. Run the diagnostic from a terminal and keep that terminal visible. Do not
   click any Clawd menu item except Hide Pet and Quit during a measurement.
5. Before the first run, copy the output of:

     echo "XDG_SESSION_TYPE=$XDG_SESSION_TYPE DISPLAY=$DISPLAY WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
     microsoft-edge --version
     xrandr --query

   If a command is unavailable, report that exact error; do not install extra
   system packages for this test.

Preferred portable package (does not require FUSE)
---------------------------------------------------

  tar -xzf Clawd-on-Desk-0.14.0-issue813diag3-x64.tar.gz
  cd Clawd-on-Desk-0.14.0-issue813diag3-x64
  ./clawd-on-desk

AppImage alternative
--------------------

  chmod +x Clawd-on-Desk-0.14.0-issue813diag3-x86_64.AppImage
  ./Clawd-on-Desk-0.14.0-issue813diag3-x86_64.AppImage

If the AppImage reports a libfuse.so.2/FUSE error, use the portable tar.gz
package instead. Do not install FUSE solely for this test.

Phase 1: default mode only
--------------------------

Start with the portable command above (mode A). Do not run modes B or C unless
the maintainer asks after reviewing phase 1.

1. Wait for PROCESS-PREFLIGHT OK, START, RUNTIME and CONFIG lines. On a Wayland
   desktop, mode A normally prints two PROCESS-PREFLIGHT/START pairs because the
   first process relaunches under XWayland. Copy the final PROCESS-PREFLIGHT and
   START lines, the single RUNTIME line, and the CONFIG line.
2. Keep the Edge window at a fixed size and use the same approximate start/end
   points. With the pet visible, perform six comparable fast, long Edge-window
   drags: three within one monitor and three across the two monitors. Wait 5-10
   seconds between attempts. Record every attempt as no freeze, short freeze,
   or long freeze, plus an approximate duration in seconds when visible.
3. Apply the baseline gate before using Hide:
   - 0 of 6 freezes: stop and report "baseline did not reproduce". Do not draw
     a conclusion from Hide in this launch.
   - 1-2 of 6 freezes: label the baseline unstable. Quit, repeat mode A once
     from a fresh launch, and report both launches before further comparison.
   - 3-6 of 6 freezes: continue with Hide in this launch.
4. Choose Hide Pet from the Clawd tray menu. The terminal must print all four
   conditions below:

     TEARDOWN OK ... auxiliaryWindows=0 externalProcesses=0
     CHECK +0s VALID ... totalWindows=0 externalProcesses=0
     CHECK +5s VALID ... totalWindows=0 externalProcesses=0
     CHECK +30s VALID ... totalWindows=0 externalProcesses=0

   BLOCKED, INVALID, a missing line, a nonzero count, or an unknown count makes
   the after-Hide measurement invalid. Quit, remove the reported extra activity,
   and restart instead of interpreting it.
5. Immediately after CHECK +5s VALID, repeat the same six drags: three within
   one monitor and three across monitors. Record every attempt as in step 2.
   Continue watching the terminal until CHECK +30s is printed.
6. Quit Clawd from the tray. Show Pet intentionally cannot restore the two
   destroyed diagnostic windows; use a fresh launch for every repeat.

Phase 2: conditional comparisons
--------------------------------

Only if requested after phase 1, use fresh launches in this order: A, B, C, A.
The final A repeat checks whether time/order drift could explain a difference.
Apply the same baseline and four-line teardown gates to every launch.

A. Default Clawd rendering policy and default Clawd backend:

     ./clawd-on-desk

   On a Wayland desktop, v0.14.0 normally relaunches Clawd under XWayland. The
   RUNTIME line must contain `"commandLineOzone":"x11"`. A GPU-policy comparison
   also requires `"gpuStatusReady":true` and
   `"hardwareAccelerationEnabled":true` in both A launches.

B. Native Wayland selection, only when XDG_SESSION_TYPE is "wayland":

     CLAWD_OZONE_PLATFORM=wayland ./clawd-on-desk

   The pet's own positioning/dragging is known to be limited in this mode; the
   measurement is Edge-window dragging, not pet dragging. The RUNTIME line must
   contain `"commandLineOzone":"wayland"`. This proves the Chromium command-line
   backend selection used for the comparison, not the release of every native
   or compositor resource. Skip B entirely on an Xorg session.

C. Default backend while requesting disabled Clawd hardware acceleration:

     ./clawd-on-desk --issue813-disable-gpu

   On a Wayland desktop, require `"commandLineOzone":"x11"` as in A. A GPU-policy
   comparison additionally requires `"gpuStatusReady":true` and
   `"hardwareAccelerationEnabled":false` in C, plus equal commandLineOzone values
   in A and C. If those gates fail, still report the drag observations but do
   not interpret them as a GPU-policy comparison.

For AppImage, replace ./clawd-on-desk with the AppImage filename.

Report template
---------------

For every launch, copy PROCESS-PREFLIGHT, START, RUNTIME and CONFIG. If the
baseline gate permits Hide, also copy TEARDOWN and all three CHECK lines;
otherwise mark those fields N/A. Then fill in:

  Mode / command:
  Baseline freezes with pet visible (count out of 6):
  Visible, within-monitor attempts (3 results and seconds):
  Visible, cross-monitor attempts (3 results and seconds):
  Baseline gate: absent / unstable / reproduced
  After Hide, within-monitor attempts (3 results and seconds):
  After Hide, cross-monitor attempts (3 results and seconds):
  TEARDOWN result:
  CHECK +0s result:
  CHECK +5s result:
  CHECK +30s result:

Interpretation limits
---------------------

- Recovery only after a fully VALID teardown is consistent with the pet
  render/hit BrowserWindow subtree contributing to maintenance of this
  reproduction. The one-way visible-to-Hide sequence has no time-matched
  no-Hide control, so it does not establish causal necessity. It also does not
  identify which window or property was responsible, nor prove a transparency,
  topmost, animation, renderer, GPU, native-surface or compositor defect.
- Native Wayland smooth while default XWayland lags makes the selected backend
  boundary a strong suspect, not a proven root cause.
- Mode C changes Clawd's whole hardware-accelerated rendering path, not one
  isolated driver flag. A difference does not by itself prove a GPU, driver,
  Edge or compositor defect.
- If lag persists after a fully VALID teardown, at least three interpretations
  remain: compositor state triggered by the removed windows persisted; the lag
  was unrelated to those windows; or Clawd's remaining non-window Electron
  process activity/display connection still mattered. The experiment does not
  distinguish those explanations.
- VALID proves only the Electron BrowserWindow topology plus the external Clawd
  main-process snapshot at the logged checkpoints. It does not prove that every
  native surface, GPU resource, X11/Wayland connection or compositor state was
  released. Thirty seconds is an observation window, not a resource-release
  guarantee.

SHA-256
-------

fdbaab57894369b6b396906fb1013cee830f5e8db4d1b4e9c2206f67c99d4c61
  Clawd-on-Desk-0.14.0-issue813diag3-x64.tar.gz

243d58e1501ba11b70672cb28c25e4128871f04a98582956e8c6cbbf588b1c8c
  Clawd-on-Desk-0.14.0-issue813diag3-x86_64.AppImage
