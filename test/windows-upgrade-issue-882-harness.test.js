"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const OBSERVER = path.join(ROOT, "scripts", "manual", "issue-882-windows-upgrade-observe.ps1");
const README = path.join(ROOT, "scripts", "manual", "README.md");
const INVESTIGATION = path.join(ROOT, "docs", "investigations", "issue-882-windows-arm64-upgrade.md");

test("#882 Windows observer records the transaction boundary without launching or stopping apps", () => {
  assert.equal(fs.existsSync(OBSERVER), true);
  const source = fs.readFileSync(OBSERVER, "utf8");

  assert.match(source, /\[string\]\$InstallDir/);
  assert.match(source, /\[string\]\$OutputPath/);
  assert.match(source, /OutputPath must be outside InstallDir/);
  assert.match(source, /GetVolumePathName/);
  assert.match(source, /GetVolumeNameForVolumeMountPoint/);
  assert.match(source, /sameInstallAndObserverTempVolume/);
  assert.match(source, /installPathChainBefore/);
  assert.match(source, /isReparsePoint/);
  assert.match(source, /Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace/);
  assert.match(source, /Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace/);
  assert.match(source, /exitStatusAvailable/);
  assert.match(source, /exitStatusHex/);
  assert.match(source, /commandLineRedacted/);
  assert.match(source, /Get-InstallTreeSnapshot/);
  assert.match(source, /complete = \$enumerationErrors\.Count -eq 0/);
  assert.match(source, /Get-ClawdRegistryState/);
  assert.match(source, /3e932233-a8b2-5530-b285-e0ceb08488f2/);
  assert.match(source, /RegistryView\]::Registry64/);
  assert.match(source, /RegistryView\]::Registry32/);
  assert.match(source, /executableVolume/);
  assert.match(source, /OutputPath already exists; refusing to overwrite evidence/);
  assert.match(source, /OutputPath ancestors must not contain a reparse point/);
  assert.match(source, /transactionSnapshots/);
  assert.match(source, /Get-InstallTreeProbe/);
  assert.match(source, /uninstall-claude-hooks\.ps1/);
  assert.doesNotMatch(source, /Get-UninstallEntries/);

  assert.doesNotMatch(source, /\b(?:Start-Process|Stop-Process|taskkill|Invoke-Expression)\b/i);
  assert.doesNotMatch(source, /\b(?:Remove-Item|Move-Item|Rename-Item)\b/i);
  assert.doesNotMatch(source, /\b(?:Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b/i);
  assert.doesNotMatch(source, /\bNew-Item\b/i);
  assert.doesNotMatch(source, /\breg(?:\.exe)?\s+(?:add|delete)\b/i);
});

test("#882 observer parses in Windows PowerShell 5.1", {
  skip: process.platform !== "win32" ? "requires Windows PowerShell" : false,
}, () => {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const escaped = OBSERVER.replaceAll("'", "''");
  const command = [
    "$tokens = $null",
    "$errors = $null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
  ].join("; ");
  const result = childProcess.spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("#882 manual plan separates observer evidence from mutating Windows cases", () => {
  assert.equal(fs.existsSync(README), true);
  assert.equal(fs.existsSync(INVESTIGATION), true);
  const readme = fs.readFileSync(README, "utf8");
  const investigation = fs.readFileSync(INVESTIGATION, "utf8");

  assert.match(readme, /Issue #882/);
  assert.match(readme, /issue-882-windows-upgrade-observe\.ps1/);
  assert.match(readme, /observer does not launch/i);
  assert.match(investigation, /same underlying volume/i);
  assert.match(investigation, /different underlying volume/i);
  assert.match(investigation, /Procmon64a\.exe/);
  assert.match(investigation, /NOT SAME DEVICE/);
  assert.match(investigation, /official v0\.14\.0/i);
  assert.match(investigation, /real update feed/i);
  assert.match(investigation, /do not recursively delete/i);
});

test("production code never imports the #882 observer", () => {
  function collectFiles(entry) {
    const stat = fs.statSync(entry);
    if (stat.isFile()) return [entry];
    return fs.readdirSync(entry, { withFileTypes: true }).flatMap((child) => {
      const childPath = path.join(entry, child.name);
      return child.isDirectory() ? collectFiles(childPath) : [childPath];
    });
  }

  const productionEntries = ["src", "hooks", "agents", "extensions", "build", "package.json"]
    .map((name) => path.join(ROOT, name));
  const production = productionEntries
    .flatMap(collectFiles)
    .filter((name) => /\.(?:js|json|nsh|ps1)$/.test(name))
    .map((name) => fs.readFileSync(name, "utf8"))
    .join("\n");
  assert.doesNotMatch(production, /issue-882-windows-upgrade-observe/i);
});
