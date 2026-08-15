[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [string]$SetupPath,

  [ValidateRange(10, 1800)]
  [int]$DurationSeconds = 180,

  [ValidateRange(50, 5000)]
  [int]$IntervalMs = 200
)

$ErrorActionPreference = "Stop"
$AppGuid = "3e932233-a8b2-5530-b285-e0ceb08488f2"
$PrimaryProcessNamePattern = '^(?:Clawd on Desk|old-uninstaller|Uninstall Clawd on Desk|Clawd-on-Desk-Setup.*)\.exe$'
$CleanupProcessNamePattern = '^(?:powershell|pwsh)\.exe$'
$ProcessWqlFilter = "Name = 'Clawd on Desk.exe' OR Name = 'old-uninstaller.exe' OR Name = 'Uninstall Clawd on Desk.exe' OR Name LIKE 'Clawd-on-Desk-Setup%.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'"

function ConvertTo-HexString {
  param([byte[]]$Bytes)
  return (($Bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Get-Sha256Text {
  param([AllowEmptyString()][string]$Value)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ConvertTo-HexString ($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))
  } finally {
    $algorithm.Dispose()
  }
}

function ConvertTo-SafePath {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value) { return $null }
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    return [regex]::Replace(
      $Value,
      [regex]::Escape($env:USERPROFILE),
      "%USERPROFILE%",
      [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
  }
  return $Value
}

function ConvertTo-SidString {
  param($Value)
  if ($null -eq $Value) { return $null }
  try {
    if ($Value -is [byte[]]) {
      return (New-Object Security.Principal.SecurityIdentifier -ArgumentList $Value, 0).Value
    }
    return [string]$Value
  } catch {
    return $null
  }
}

function Test-IsSameOrChildPath {
  param([string]$Candidate, [string]$Parent)
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $candidateFull.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
    $candidateFull.StartsWith($parentFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

if (-not ("ClawdIssue882VolumeApi" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ClawdIssue882VolumeApi {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetVolumePathName(
    string fileName,
    StringBuilder volumePathName,
    uint bufferLength);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool GetVolumeNameForVolumeMountPoint(
    string volumeMountPoint,
    StringBuilder volumeName,
    uint bufferLength);
}
'@
}

function Get-VolumeIdentity {
  param([string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath
  $mountPoint = New-Object Text.StringBuilder 1024
  if (-not [ClawdIssue882VolumeApi]::GetVolumePathName($resolved, $mountPoint, 1024)) {
    throw "GetVolumePathName failed for $resolved with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $volumeName = New-Object Text.StringBuilder 1024
  if (-not [ClawdIssue882VolumeApi]::GetVolumeNameForVolumeMountPoint($mountPoint.ToString(), $volumeName, 1024)) {
    throw "GetVolumeNameForVolumeMountPoint failed for $resolved with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $storage = $null
  try {
    $storage = Get-Volume -FilePath $resolved -ErrorAction Stop
  } catch {
    $storage = $null
  }

  return [ordered]@{
    path = ConvertTo-SafePath $resolved
    mountPoint = ConvertTo-SafePath $mountPoint.ToString()
    volumeName = $volumeName.ToString()
    driveLetter = if ($storage) { [string]$storage.DriveLetter } else { $null }
    fileSystem = if ($storage) { [string]$storage.FileSystem } else { $null }
    driveType = if ($storage) { [string]$storage.DriveType } else { $null }
    healthStatus = if ($storage) { [string]$storage.HealthStatus } else { $null }
    size = if ($storage) { [long]$storage.Size } else { $null }
    sizeRemaining = if ($storage) { [long]$storage.SizeRemaining } else { $null }
  }
}

function Get-ReparseChain {
  param([string]$Path)
  $result = @()
  $item = Get-Item -LiteralPath $Path -Force
  while ($item) {
    $linkTypeProperty = $item.PSObject.Properties["LinkType"]
    $targetProperty = $item.PSObject.Properties["Target"]
    $targets = @()
    if ($targetProperty -and $null -ne $targetProperty.Value) {
      $targets = @($targetProperty.Value | ForEach-Object { ConvertTo-SafePath ([string]$_) })
    }
    $result += [ordered]@{
      path = ConvertTo-SafePath $item.FullName
      attributes = [string]$item.Attributes
      isReparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
      linkType = if ($linkTypeProperty) { [string]$linkTypeProperty.Value } else { $null }
      targets = $targets
    }
    $item = $item.Parent
  }
  return $result
}

function Get-KeyFileEvidence {
  param([string]$Path)
  $names = @(
    "Clawd on Desk.exe",
    "Uninstall Clawd on Desk.exe",
    "old-uninstaller.exe"
  )
  $result = @()
  foreach ($name in $names) {
    $candidate = Join-Path $Path $name
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $candidate
    $sha256 = $null
    $hashError = $null
    try {
      $sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    } catch {
      $hashError = ConvertTo-SafePath $_.Exception.Message
    }
    $result += [ordered]@{
      relativePath = $name
      length = [long]$item.Length
      lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
      sha256 = $sha256
      hashError = $hashError
    }
  }
  return $result
}

function Get-InstallTreeSnapshot {
  param([string]$Path, [switch]$SkipHashes)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return [ordered]@{
      exists = $false
      complete = $true
      errorCount = 0
      errors = @()
    }
  }

  $enumerationErrors = @()
  $items = @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction SilentlyContinue -ErrorVariable +enumerationErrors)
  $files = @($items | Where-Object { -not $_.PSIsContainer })
  $directories = @($items | Where-Object { $_.PSIsContainer })
  $topLevel = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue -ErrorVariable +enumerationErrors | ForEach-Object {
    [ordered]@{
      name = $_.Name
      kind = if ($_.PSIsContainer) { "directory" } else { "file" }
      length = if ($_.PSIsContainer) { $null } else { [long]$_.Length }
      attributes = [string]$_.Attributes
      lastWriteTimeUtc = $_.LastWriteTimeUtc.ToString("o")
    }
  })

  $totalBytes = [long]0
  foreach ($file in $files) { $totalBytes += [long]$file.Length }
  return [ordered]@{
    exists = $true
    complete = $enumerationErrors.Count -eq 0
    errorCount = $enumerationErrors.Count
    errors = @($enumerationErrors | Select-Object -First 20 | ForEach-Object {
      ConvertTo-SafePath $_.Exception.Message
    })
    fileCount = $files.Count
    directoryCount = $directories.Count
    totalBytes = $totalBytes
    keyFiles = if ($SkipHashes) { @() } else { @(Get-KeyFileEvidence $Path) }
    topLevel = $topLevel
  }
}

function Get-InstallTreeProbe {
  param([string]$Path)
  $anchors = @(
    "Clawd on Desk.exe",
    "Uninstall Clawd on Desk.exe",
    "resources\app.asar",
    "resources\app.asar.unpacked\hooks\cleanup-integrations.js",
    ".clawd-install-user-home"
  )
  $result = @()
  foreach ($relativePath in $anchors) {
    $candidate = Join-Path $Path $relativePath
    try {
      $exists = Test-Path -LiteralPath $candidate
      $result += [ordered]@{
        relativePath = $relativePath
        exists = [bool]$exists
        error = $null
      }
    } catch {
      $result += [ordered]@{
        relativePath = $relativePath
        exists = $null
        error = ConvertTo-SafePath $_.Exception.Message
      }
    }
  }
  return [ordered]@{
    installDirExists = Test-Path -LiteralPath $Path -PathType Container
    anchors = $result
  }
}

function Get-ClawdRegistryState {
  $result = @()
  $subKeys = @(
    [ordered]@{ role = "install"; path = "Software\$AppGuid" },
    [ordered]@{ role = "uninstall"; path = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid" }
  )
  $hives = @(
    [ordered]@{ name = "HKCU"; value = [Microsoft.Win32.RegistryHive]::CurrentUser },
    [ordered]@{ name = "HKLM"; value = [Microsoft.Win32.RegistryHive]::LocalMachine }
  )
  $views = @(
    [Microsoft.Win32.RegistryView]::Registry64,
    [Microsoft.Win32.RegistryView]::Registry32
  )
  $valueNames = @(
    "InstallLocation",
    "KeepShortcuts",
    "ShortcutName",
    "MenuDirectory",
    "UninstallString",
    "QuietUninstallString",
    "DisplayName",
    "DisplayVersion"
  )

  foreach ($hive in $hives) {
    foreach ($view in $views) {
      foreach ($subKey in $subKeys) {
        $baseKey = $null
        $key = $null
        try {
          $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive.value, $view)
          $key = $baseKey.OpenSubKey($subKey.path, $false)
          $values = [ordered]@{}
          if ($key) {
            foreach ($valueName in $valueNames) {
              $value = $key.GetValue($valueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
              if ($null -ne $value) {
                $values[$valueName] = ConvertTo-SafePath ([string]$value)
              }
            }
          }
          $result += [ordered]@{
            hive = $hive.name
            view = [string]$view
            role = $subKey.role
            subKey = $subKey.path
            exists = $null -ne $key
            values = $values
          }
        } catch {
          $result += [ordered]@{
            hive = $hive.name
            view = [string]$view
            role = $subKey.role
            subKey = $subKey.path
            exists = $null
            error = ConvertTo-SafePath $_.Exception.Message
          }
        } finally {
          if ($key) { $key.Dispose() }
          if ($baseKey) { $baseKey.Dispose() }
        }
      }
    }
  }
  return $result
}

function Get-ProcessEvidence {
  param($Process, [string]$At, [string]$Source)
  $commandLine = [string]$Process.CommandLine
  $executablePath = [string]$Process.ExecutablePath
  $ownerSid = $null
  $ownerSidError = $null
  try {
    $ownerResult = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction Stop
    if ($ownerResult.ReturnValue -eq 0) { $ownerSid = [string]$ownerResult.Sid }
  } catch {
    $ownerSid = $null
    $ownerSidError = ConvertTo-SafePath $_.Exception.Message
  }
  $executableVolume = $null
  if (
    $Process.Name -match '^(?:old-uninstaller|Uninstall Clawd on Desk)\.exe$' -and
    -not [string]::IsNullOrWhiteSpace($executablePath) -and
    (Test-Path -LiteralPath $executablePath -PathType Leaf)
  ) {
    try {
      $executableVolume = Get-VolumeIdentity (Split-Path -Parent $executablePath)
    } catch {
      $executableVolume = [ordered]@{ error = ConvertTo-SafePath $_.Exception.Message }
    }
  }
  return [ordered]@{
    pid = [int]$Process.ProcessId
    parentPid = [int]$Process.ParentProcessId
    sessionId = [uint32]$Process.SessionId
    ownerSid = $ownerSid
    ownerSidError = $ownerSidError
    image = [string]$Process.Name
    executablePath = ConvertTo-SafePath $executablePath
    executableSha256 = $null
    executableHashNotCollectedDuringLiveObservation = $Process.Name -match '^(?:old-uninstaller|Uninstall Clawd on Desk)\.exe$'
    executableVolume = $executableVolume
    executableSharesInstallVolume = if ($executableVolume -and $executableVolume.volumeName) {
      $executableVolume.volumeName -eq $installVolume.volumeName
    } else { $null }
    commandLineRedacted = ConvertTo-SafePath $commandLine
    commandHash = Get-Sha256Text $commandLine
    firstSeenAt = $At
    lastSeenAt = $At
    source = $Source
  }
}

function Test-IsRelevantProcess {
  param($Process)
  if ([uint32]$Process.SessionId -ne [uint32]$observerSessionId) { return $false }
  if ($Process.Name -match '^Clawd-on-Desk-Setup.*\.exe$') {
    if ([string]::IsNullOrWhiteSpace($SetupPath)) { return $true }
    $actualSetupPath = [string]$Process.ExecutablePath
    return (
      -not [string]::IsNullOrWhiteSpace($actualSetupPath) -and
      $actualSetupPath.Equals($SetupPath, [StringComparison]::OrdinalIgnoreCase)
    )
  }
  if ($Process.Name -match $PrimaryProcessNamePattern) { return $true }
  if ($Process.Name -notmatch $CleanupProcessNamePattern) { return $false }
  $commandLine = [string]$Process.CommandLine
  return (
    $commandLine.IndexOf("uninstall-claude-hooks.ps1", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
  )
}

function Get-ProcessKey {
  param($Process)
  return "$($Process.ProcessId)|$([string]$Process.CreationDate)"
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal $identity
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$InstallDir = (Resolve-Path -LiteralPath $InstallDir).ProviderPath.TrimEnd('\')
if (-not [IO.Path]::IsPathRooted($OutputPath)) { throw "OutputPath must be an absolute filesystem path" }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw "OutputPath already exists; refusing to overwrite evidence" }
$outputParent = Split-Path -Parent $OutputPath
if (-not $outputParent) { throw "OutputPath must have a parent directory" }
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
  throw "OutputPath parent must already exist"
}
$outputParent = (Resolve-Path -LiteralPath $outputParent).ProviderPath
$outputChain = @(Get-ReparseChain $outputParent)
if (@($outputChain | Where-Object { $_.isReparsePoint }).Count -gt 0) {
  throw "OutputPath ancestors must not contain a reparse point"
}
$OutputPath = Join-Path $outputParent (Split-Path -Leaf $OutputPath)
if (Test-IsSameOrChildPath $OutputPath $InstallDir) {
  throw "OutputPath must be outside InstallDir so observation does not alter or disappear with the install tree"
}

$setupEvidence = $null
if (-not [string]::IsNullOrWhiteSpace($SetupPath)) {
  $SetupPath = (Resolve-Path -LiteralPath $SetupPath).ProviderPath
  $setupItem = Get-Item -LiteralPath $SetupPath
  $setupEvidence = [ordered]@{
    path = ConvertTo-SafePath $setupItem.FullName
    length = [long]$setupItem.Length
    sha256 = (Get-FileHash -LiteralPath $setupItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    authenticodeStatus = [string](Get-AuthenticodeSignature -LiteralPath $setupItem.FullName).Status
    fileVersion = [string]$setupItem.VersionInfo.FileVersion
    productVersion = [string]$setupItem.VersionInfo.ProductVersion
  }
}

$observerSessionId = [uint32](Get-Process -Id $PID).SessionId
$observerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$installVolume = Get-VolumeIdentity $InstallDir
$tempVolume = Get-VolumeIdentity $env:TEMP
$installPathChainBefore = @(Get-ReparseChain $InstallDir)
$beforeTree = Get-InstallTreeSnapshot $InstallDir
$beforeRegistry = @(Get-ClawdRegistryState)
$processes = @{}
$relevantPids = @{}
$processEvents = @()
$transactionSnapshots = @()
$transitions = @()
$previousSignature = $null
$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($DurationSeconds)
$drainDeadline = $deadline.AddMilliseconds([Math]::Max(500, $IntervalMs * 2))
$startSource = "ClawdIssue882Start-$PID"
$stopSource = "ClawdIssue882Stop-$PID"
$startRegistered = $false
$stopRegistered = $false
$observationError = $null

try {
  Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $startSource | Out-Null
  $startRegistered = $true
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier $stopSource | Out-Null
  $stopRegistered = $true
  Write-Host "Issue #882 observer ready for one upgrade attempt; no process will be launched or stopped."

  while ($true) {
    $now = Get-Date
    $nowText = $now.ToString("o")

    $queuedEvents = @()
    $queuedEvents += @(Get-Event -SourceIdentifier $startSource -ErrorAction SilentlyContinue)
    $queuedEvents += @(Get-Event -SourceIdentifier $stopSource -ErrorAction SilentlyContinue)
    foreach ($event in @($queuedEvents | Sort-Object TimeGenerated, EventIdentifier)) {
        $record = $event.SourceEventArgs.NewEvent
        $name = [string]$record.ProcessName
        $eventKind = if ($event.SourceIdentifier -eq $startSource) { "start" } else { "stop" }
        $eventTimeText = $event.TimeGenerated.ToString("o")
        $eventPid = [int]$record.ProcessID
        $eventSessionId = [uint32]$record.SessionID
        $process = $null
        $shouldRecord = $name -match $PrimaryProcessNamePattern -and $eventSessionId -eq $observerSessionId
        if (
          $shouldRecord -and
          $name -match '^Clawd-on-Desk-Setup.*\.exe$' -and
          -not [string]::IsNullOrWhiteSpace($SetupPath)
        ) {
          if ($eventKind -eq "start") {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $eventPid" -ErrorAction SilentlyContinue
            $shouldRecord = $process -and (Test-IsRelevantProcess $process)
          } else {
            $shouldRecord = $relevantPids.ContainsKey([string]$eventPid)
          }
        }
        if (-not $shouldRecord -and $name -match $CleanupProcessNamePattern) {
          if ($eventKind -eq "start") {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $eventPid" -ErrorAction SilentlyContinue
            $shouldRecord = ($process -and (Test-IsRelevantProcess $process)) -or
              $relevantPids.ContainsKey([string]$record.ParentProcessID)
          } else {
            $shouldRecord = $relevantPids.ContainsKey([string]$eventPid)
          }
        }
        if ($shouldRecord) {
          $exitStatusProperty = $record.PSObject.Properties["ExitStatus"]
          $exitStatusAvailable = $eventKind -eq "stop" -and $exitStatusProperty -and $null -ne $exitStatusProperty.Value
          $exitStatus = if ($exitStatusAvailable) { [uint32]$exitStatusProperty.Value } else { $null }
          $processEvents += [ordered]@{
            at = $eventTimeText
            kind = $eventKind
            image = $name
            pid = $eventPid
            parentPid = [int]$record.ParentProcessID
            sessionId = $eventSessionId
            sid = ConvertTo-SidString $record.Sid
            exitStatusAvailable = [bool]$exitStatusAvailable
            exitStatus = $exitStatus
            exitStatusHex = if ($exitStatusAvailable) { "0x{0:X8}" -f $exitStatus } else { $null }
          }
          if ($eventKind -eq "stop" -and $name -ieq "old-uninstaller.exe") {
            $captureStartedAt = Get-Date
            $transactionTree = Get-InstallTreeProbe -Path $InstallDir
            $transactionRegistry = @(Get-ClawdRegistryState)
            $transactionSnapshots += [ordered]@{
              triggerEventAt = $eventTimeText
              captureStartedAt = $captureStartedAt.ToString("o")
              captureFinishedAt = (Get-Date).ToString("o")
              oldUninstallerPid = $eventPid
              exitStatusAvailable = [bool]$exitStatusAvailable
              exitStatus = $exitStatus
              exitStatusHex = if ($exitStatusAvailable) { "0x{0:X8}" -f $exitStatus } else { $null }
              installTree = $transactionTree
              registry = $transactionRegistry
            }
          }
          if ($eventKind -eq "start") {
            $relevantPids[[string]$eventPid] = $true
            if (-not $process) {
              $process = Get-CimInstance Win32_Process -Filter "ProcessId = $eventPid" -ErrorAction SilentlyContinue
            }
            if ($process) {
              $key = Get-ProcessKey $process
              if (-not $processes.ContainsKey($key)) {
                $processes[$key] = Get-ProcessEvidence $process $eventTimeText "start-event"
              }
            }
          } else {
            $relevantPids.Remove([string]$eventPid)
          }
        }
        Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue
    }

    $matches = @(Get-CimInstance Win32_Process -Filter $ProcessWqlFilter -ErrorAction SilentlyContinue | Where-Object {
      Test-IsRelevantProcess $_
    })
    foreach ($process in $matches) {
      $key = Get-ProcessKey $process
      if (-not $processes.ContainsKey($key)) {
        $processes[$key] = Get-ProcessEvidence $process $nowText "poll"
      } else {
        $processes[$key].lastSeenAt = $nowText
      }
      $relevantPids[[string]$process.ProcessId] = $true
    }

    $signature = (($matches | Sort-Object Name, ProcessId | ForEach-Object {
      "$($_.Name):$($_.ProcessId)"
    }) -join ",")
    if ($signature -ne $previousSignature) {
      $transitions += [ordered]@{
        at = $nowText
        processCount = $matches.Count
        signature = $signature
      }
      $previousSignature = $signature
    }
    $remainingMs = [int][Math]::Max(0, ($drainDeadline - (Get-Date)).TotalMilliseconds)
    if ($remainingMs -eq 0) { break }
    Start-Sleep -Milliseconds ([Math]::Min($IntervalMs, $remainingMs))
  }
} catch {
  $observationError = ConvertTo-SafePath $_.Exception.Message
} finally {
  if ($startRegistered) { Unregister-Event -SourceIdentifier $startSource -ErrorAction SilentlyContinue }
  if ($stopRegistered) { Unregister-Event -SourceIdentifier $stopSource -ErrorAction SilentlyContinue }
  Get-Event -SourceIdentifier $startSource -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier $stopSource -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
}

$result = [ordered]@{
  version = 1
  issue = 882
  observerOnly = $true
  startedAt = $startedAt.ToString("o")
  finishedAt = (Get-Date).ToString("o")
  durationSeconds = $DurationSeconds
  intervalMs = $IntervalMs
  observationError = $observationError
  environment = [ordered]@{
    osArchitecture = [string](Get-CimInstance Win32_OperatingSystem).OSArchitecture
    processArchitecture = [string]$env:PROCESSOR_ARCHITECTURE
    nativeArchitecture = [string]$env:PROCESSOR_ARCHITEW6432
    powershellVersion = [string]$PSVersionTable.PSVersion
    is64BitProcess = [Environment]::Is64BitProcess
    isAdministrator = Test-IsAdministrator
    currentUserSid = [string]$observerIdentity.User.Value
    observerSessionId = $observerSessionId
  }
  paths = [ordered]@{
    installDir = ConvertTo-SafePath $InstallDir
    observerTempDir = ConvertTo-SafePath ((Resolve-Path -LiteralPath $env:TEMP).ProviderPath)
    sameInstallAndObserverTempVolume = $installVolume.volumeName -eq $tempVolume.volumeName
    installVolume = $installVolume
    observerTempVolume = $tempVolume
    installPathChainBefore = $installPathChainBefore
  }
  setup = $setupEvidence
  before = [ordered]@{
    installTree = $beforeTree
    registry = $beforeRegistry
  }
  after = [ordered]@{
    installTree = Get-InstallTreeSnapshot $InstallDir
    registry = @(Get-ClawdRegistryState)
  }
  processTransitions = $transitions
  processEvents = $processEvents
  transactionSnapshots = $transactionSnapshots
  processes = @($processes.Values | Sort-Object firstSeenAt, pid)
}

$utf8NoBom = New-Object Text.UTF8Encoding -ArgumentList $false
[IO.File]::WriteAllText($OutputPath, ($result | ConvertTo-Json -Depth 10), $utf8NoBom)
Write-Host "Issue #882 read-only observation saved to $OutputPath"
Write-Host "Install and observer TEMP share underlying volume: $($result.paths.sameInstallAndObserverTempVolume)"
