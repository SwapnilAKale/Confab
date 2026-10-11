# Removes Local Voice for the current Windows user: every agent connection (each agent's file restored), the background
# service, login startup, the Start menu entry, the Settings > Apps entry, the runtime, the app and the profile.
#   -KeepModels | -DeleteModels   keep or delete the downloaded speech models (otherwise it asks)
#   -Gui                          started from the tray: no console; the questions were asked there and the result is shown in a window
param([switch]$KeepModels, [switch]$DeleteModels, [switch]$Gui)
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $env:TEMP
. (Join-Path $PSScriptRoot 'windows-shell.ps1')
# From inside a packaged app's terminal, only that app's private copy of AppData would be cleaned.
$sandbox = Get-AppDataRedirect
if ($sandbox) {
    $passOn = @(); if ($KeepModels) { $passOn += '-KeepModels' }; if ($DeleteModels) { $passOn += '-DeleteModels' }; if ($Gui) { $passOn += '-Gui' }
    # The copy in %TEMP% keeps running after the app folder it came from is deleted.
    $copy = Join-Path $env:TEMP 'local-voice-uninstall.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-shell.ps1') -Destination (Join-Path $env:TEMP 'windows-shell.ps1') -Force
    Restart-OutsideSandbox -Script $copy -Arguments $passOn -App $sandbox
    exit 3
}
$base = Join-Path $env:LOCALAPPDATA 'LocalVoice'
$app = Join-Path $base 'app'
$node = Join-Path $base 'runtime\node\node.exe'
$profileDir = Join-Path $base 'resident'
$log = New-Object System.Collections.Generic.List[string]
function Say($text) { $log.Add($text); if (-not $Gui) { Write-Host $text } }

if (-not $KeepModels -and -not $DeleteModels) {
    if ($Gui) { $KeepModels = $true }
    else {
        Write-Host 'Uninstall Local Voice' -ForegroundColor White
        $answer = Read-Host 'Delete the downloaded speech models too (about 1 GB)? Keep them to reinstall later without downloading. [D]elete / [K]eep (default: Delete)'
        if ($answer -match '^[kK]') { $KeepModels = $true }
    }
}

# 1. Agent connections, while the app and its runtime still exist.
$agentsScript = Join-Path $app 'scripts\agents.cjs'
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $agentsScript)) {
    $results = (& $node $agentsScript disconnect all --json) | ConvertFrom-Json
    foreach ($r in $results) { foreach ($line in $r.lines) { if ($line -notmatch '^No Local Voice hook') { Say ('Agents: ' + $r.id + ': ' + $line) } } }
    if (@($results | Where-Object { -not $_.ok }).Count) { Say 'Agents: some agent files differed from their backups; the backups were kept beside them (*.local-voice.bak).' }
    else { Say 'Agents: every Local Voice hook removed.' }
} else { Say 'Agents: the app or its runtime is already gone, so agent hooks could not be checked. Run setup and uninstall again to remove them.' }

# 2. The service and anything else run by Local Voice's own runtime (hooks in flight, the tray's helpers).
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Say 'Service: stopped.'

# 3. Login startup, Start menu entry, Settings > Apps entry.
Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LocalVoice' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Local Voice.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalVoice' -Recurse -Force -ErrorAction SilentlyContinue
Say 'Startup: login entry, Start menu entry and Settings > Apps entry removed.'

# 4. Files. Kept models stay at their place inside app\assets, so setup finds and re-verifies them.
$keep = @()
if ($KeepModels) { $keep = @((Join-Path $app 'assets\models'), (Join-Path $app 'assets\models-verified.json')) }
# Models an earlier version used ("retired" in the manifest) are never kept: delete them before anything else.
try {
    $retired = (Get-Content -LiteralPath (Join-Path $app 'assets\live-models.json') -Raw | ConvertFrom-Json).retired
    foreach ($r in $retired) { $dir = Join-Path $app ($r.path -replace '/', '\'); if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue } }
} catch { }
function Remove-Tree($path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    foreach ($k in $keep) { if ($k.StartsWith($path.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $k -ieq $path) {
        Get-ChildItem -LiteralPath $path -Force | ForEach-Object { Remove-Tree $_.FullName }; return } }
    for ($i = 0; $i -lt 5; $i++) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Test-Path -LiteralPath $path)) { return }; Start-Sleep -Milliseconds 600 }
}
if (Test-Path -LiteralPath $base) { Get-ChildItem -LiteralPath $base -Force | ForEach-Object { Remove-Tree $_.FullName } }
$left = @()
if (Test-Path -LiteralPath $base) { $left = @(Get-ChildItem -LiteralPath $base -Recurse -Force -File | Where-Object { $f = $_.FullName; -not ($keep | Where-Object { $f.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) }) }
if (-not $KeepModels -and -not $left.Count) { Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue }
if ($left.Count) { Say ('Files: ' + $left.Count + ' file(s) could not be deleted because they are in use (first: ' + $left[0].FullName + '). Close any window open in that folder and run uninstall again, or delete ' + $base + ' after restarting.') }
elseif ($KeepModels) { Say ('Files: removed. The speech models were kept in ' + (Join-Path $app 'assets') + '; setup will reuse them, or delete ' + $base + ' to remove them.') }
else { Say ('Files: ' + $base + ' deleted, including the speech models.') }
# Setup's log and any launchers left in %TEMP% by earlier runs.
Remove-StaleLaunchers
Remove-Item -LiteralPath (Join-Path $env:TEMP 'local-voice-setup.log') -Force -ErrorAction SilentlyContinue
# The copies made in %TEMP% when this run was moved out of an app's sandbox.
if ($PSScriptRoot -ieq $env:TEMP.TrimEnd('\')) { Remove-Item -LiteralPath (Join-Path $env:TEMP 'windows-shell.ps1'), $PSCommandPath -Force -ErrorAction SilentlyContinue }
$summary = 'Local Voice was uninstalled.'
if ($left.Count) { $summary = 'Local Voice was uninstalled, except for some files in use.' }
Say $summary
if ($Gui) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(($log -join "`r`n`r`n"), 'Local Voice', 'OK', 'Information')
}
