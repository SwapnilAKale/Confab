# Local Voice setup for the current Windows user. Run it with setup.cmd (no administrator rights, no settings changed).
# Installs into %LOCALAPPDATA%\LocalVoice: the app, its own Node.js runtime, the speech models (checked against
# assets\live-models.json), login startup and a Start menu entry. Safe to run again: it repairs or updates in place.
#   -Agents ask|all|none|<id,id>   which detected agents to connect at the end (default: ask for each)
param([string]$Agents = 'ask')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$base = Join-Path $env:LOCALAPPDATA 'LocalVoice'
$app = Join-Path $base 'app'
$runtime = Join-Path $base 'runtime\node'
$downloads = Join-Path $base 'downloads'
$profileDir = Join-Path $base 'resident'
$node = Join-Path $runtime 'node.exe'
$system32 = Join-Path $env:SystemRoot 'System32'

. (Join-Path $PSScriptRoot 'windows-shell.ps1')
# Installed from inside a packaged app's terminal, Local Voice would land in that app's private AppData.
$sandbox = Get-AppDataRedirect
if ($sandbox) {
    $passOn = @(); if ($Agents -ne 'ask') { $passOn = @('-Agents', $Agents) }
    Restart-OutsideSandbox -Script $PSCommandPath -Arguments $passOn -App $sandbox
    Write-Host ('A log of that run is written to ' + (Join-Path $env:TEMP 'local-voice-setup.log') + '.')
    exit 3
}
Remove-StaleLaunchers
try { Start-Transcript -LiteralPath (Join-Path $env:TEMP 'local-voice-setup.log') -Force | Out-Null } catch { }

function Step($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
function Ok($text) { Write-Host ('  OK  ' + $text) -ForegroundColor Green }
function Info($text) { Write-Host ('      ' + $text) }
function Fail($text) { Write-Host ''; Write-Host ('Setup stopped: ' + $text) -ForegroundColor Red; Write-Host 'Nothing outside %LOCALAPPDATA%\LocalVoice was changed. Fix the problem above and run setup again; it carries on where it stopped.'; exit 1 }

Write-Host 'Local Voice setup' -ForegroundColor White
Write-Host ('Installing for ' + $env:USERNAME + ' into ' + $base)

# --- 1. Prerequisites ---------------------------------------------------------------------------------------------
Step '1/6  Checking this PC'
$problems = @()
if (-not [Environment]::Is64BitOperatingSystem) { $problems += 'Local Voice needs 64-bit Windows 10 or 11.' }
$build = [Environment]::OSVersion.Version.Build
if ([Environment]::OSVersion.Version.Major -lt 10 -or $build -lt 17763) { $problems += ('Local Voice needs Windows 10 version 1809 or later (this PC: build ' + $build + ').') }
else { Ok ('Windows build ' + $build + ', 64-bit') }
foreach ($tool in @('tar.exe', 'curl.exe', 'robocopy.exe', 'reg.exe')) { if (-not (Test-Path -LiteralPath (Join-Path $system32 $tool))) { $problems += ('Windows is missing ' + $tool + ' (normally in ' + $system32 + ').') } }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) { $problems += 'This window is running as administrator. Open a normal PowerShell window (not "Run as administrator") and run setup there, so Local Voice is installed for your own account.' }
else { Ok 'Running as a standard user (no administrator rights needed)' }
$drive = (Get-Item -LiteralPath $env:LOCALAPPDATA).PSDrive
$freeGb = [math]::Round($drive.Free / 1GB, 1)
$needGb = 3.0
if (Test-Path -LiteralPath (Join-Path $app 'assets\models')) { $needGb = 0.5 }
if ($drive.Free / 1GB -lt $needGb) { $problems += ('Not enough free disk space on ' + $drive.Name + ': ' + $freeGb + ' GB free, about ' + $needGb + ' GB needed.') }
else { Ok ('Disk space: ' + $freeGb + ' GB free on ' + $drive.Name + ':') }
if (-not (Test-Path -LiteralPath (Join-Path $source 'assets\live-models.json'))) { $problems += ('This folder is not a complete copy of Local Voice: ' + $source) }
$mics = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='AudioEndpoint'" -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'Microphone|Mic|Headset|Input|Array' })
if ($mics.Count) { Ok ('Microphone: ' + $mics[0].Name) } else { Info 'No microphone found. Setup continues; plug one in before dictating.' }
if ($problems.Count) { foreach ($p in $problems) { Write-Host ('  X   ' + $p) -ForegroundColor Red }; Fail 'this PC is missing what Local Voice needs (listed above).' }

New-Item -ItemType Directory -Path $base -Force | Out-Null

# Stop a running Local Voice first, so its files can be updated.
$endpointFile = Join-Path $profileDir 'endpoint.json'
if (Test-Path -LiteralPath $endpointFile) {
    try {
        $running = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$running.pid) -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -like '*resident.cjs*') { Info 'Stopping the running Local Voice while it is updated...'; Stop-Process -Id $process.ProcessId -Force; Start-Sleep -Milliseconds 800 }
    } catch { }
}

# --- 2. Node.js runtime -------------------------------------------------------------------------------------------
Step '2/6  Node.js runtime (official build, used only by Local Voice)'
$pin = (Get-Content -LiteralPath (Join-Path $source 'assets\runtime.json') -Raw | ConvertFrom-Json).node
function Test-Runtime {
    if (-not (Test-Path -LiteralPath $node)) { return $false }
    $signature = Get-AuthenticodeSignature -LiteralPath $node
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch [regex]::Escape($pin.signer)) { return $false }
    try { $version = & $node -v 2>$null } catch { return $false }
    return ($version -eq ('v' + $pin.version))
}
if (Test-Runtime) { Ok ('Node.js ' + $pin.version + ' already installed') }
else {
    New-Item -ItemType Directory -Path $downloads -Force | Out-Null
    $zip = Join-Path $downloads ([IO.Path]::GetFileName($pin.url))
    $have = 0; if (Test-Path -LiteralPath $zip) { $have = (Get-Item -LiteralPath $zip).Length }
    if ($have -gt $pin.size) { Remove-Item -LiteralPath $zip -Force; $have = 0 }
    if ($have -lt $pin.size) {
        Info ('Downloading ' + $pin.url)
        # curl.exe ships with Windows. -C - resumes an interrupted download.
        & (Join-Path $system32 'curl.exe') -L --fail --retry 3 -C - --progress-bar -o $zip $pin.url
        if ($LASTEXITCODE -ne 0) { Fail ('could not download Node.js (curl exit ' + $LASTEXITCODE + '). Check the internet connection.') }
    }
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $pin.sha256) { Remove-Item -LiteralPath $zip -Force; Fail ('the Node.js download did not match its SHA-256 checksum (got ' + $hash + '). It was deleted; run setup again.') }
    Ok 'Download matches the SHA-256 in assets\runtime.json'
    $staging = Join-Path $base 'runtime\staging'
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    & (Join-Path $system32 'tar.exe') -xf $zip -C $staging
    if ($LASTEXITCODE -ne 0) { Fail 'could not unpack Node.js.' }
    Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath (Join-Path $staging $pin.folder) -Destination $runtime
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip -Force
    $signature = Get-AuthenticodeSignature -LiteralPath $node
    if ($signature.Status -ne 'Valid') { Fail ('node.exe is not validly signed (' + $signature.Status + ').') }
    try { $version = & $node -v } catch { Fail ('Windows did not let node.exe run: ' + $_.Exception.Message + '. If Smart App Control blocked it, it is reported in Windows Security > App & browser control.') }
    if ($version -ne ('v' + $pin.version)) { Fail ('node.exe did not start (' + $version + ').') }
    Ok ('Node.js ' + $pin.version + ' installed, signed by ' + $pin.signer + ', and allowed to run by Windows')
}

# --- 3. App files and libraries -----------------------------------------------------------------------------------
Step '3/6  Local Voice app'
if ($source.TrimEnd('\') -ieq $app.TrimEnd('\')) { Ok 'Running from the installed app: repairing in place' }
else {
    New-Item -ItemType Directory -Path $app -Force | Out-Null
    # Mirror the code folders; the speech models in app\assets\models are kept. Folders of models an earlier version
    # used ("retired" in assets\live-models.json) are deleted by the model step below.
    foreach ($dir in @('src', 'scripts', 'docs', 'assets\notices')) {
        & (Join-Path $system32 'robocopy.exe') (Join-Path $source $dir) (Join-Path $app $dir) /MIR /NJH /NJS /NFL /NDL /NP /R:2 /W:1 /XD __pycache__ | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail ('could not copy ' + $dir + ' (robocopy exit ' + $LASTEXITCODE + ').') }
    }
    foreach ($file in @('package.json', 'package-lock.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'setup.cmd', 'uninstall.cmd', 'assets\live-models.json', 'assets\runtime.json')) {
        $target = Join-Path $app $file
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination $target -Force
    }
    Ok ('Copied to ' + $app)
}
$lockHash = (Get-FileHash -LiteralPath (Join-Path $app 'package-lock.json') -Algorithm SHA256).Hash
$lockStamp = Join-Path $app 'node_modules\.local-voice-lock'
$haveModules = (Test-Path -LiteralPath $lockStamp) -and ((Get-Content -LiteralPath $lockStamp -Raw).Trim() -eq $lockHash)
if ($haveModules) { Ok 'Libraries up to date' }
else {
    Info 'Installing the two libraries (koffi, sherpa-onnx-node) from npm, checked against package-lock.json...'
    $env:Path = $runtime + ';' + $env:Path
    $cache = Join-Path $downloads 'npm-cache'
    Push-Location $app
    try { & $node (Join-Path $runtime 'node_modules\npm\bin\npm-cli.js') ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error --cache $cache }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail 'npm could not install the libraries. Check the internet connection.' }
    Set-Content -LiteralPath $lockStamp -Value $lockHash
    Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
    Ok 'Libraries installed'
}

# --- 4. Speech models ---------------------------------------------------------------------------------------------
Step '4/6  Speech models (about 1 GB on first install; checked against assets\live-models.json)'
& $node (Join-Path $app 'scripts\models.cjs') fetch
if ($LASTEXITCODE -ne 0) { Fail 'the speech models could not be downloaded or checked (see above). Run setup again to resume.' }
Remove-Item -LiteralPath $downloads -Recurse -Force -ErrorAction SilentlyContinue

# --- 5. Background service, login startup, Start menu --------------------------------------------------------------
Step '5/6  Background service'
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'scripts\install-resident.ps1') -StartNow | ForEach-Object { Info $_ }
if ($LASTEXITCODE -ne 0) { Fail 'could not install the background service.' }
# An entry in Settings > Apps > Installed apps (per user, no administrator rights).
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalVoice'
New-Item -Path $uninstallKey -Force | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
$uninstallCmd = '"' + (Join-Path $app 'uninstall.cmd') + '"'
foreach ($pair in @(@('DisplayName', 'Local Voice'), @('DisplayVersion', $version), @('Publisher', 'Local Voice'), @('InstallLocation', $base), @('UninstallString', $uninstallCmd))) {
    New-ItemProperty -LiteralPath $uninstallKey -Name $pair[0] -Value $pair[1] -PropertyType String -Force | Out-Null
}
foreach ($flag in @('NoModify', 'NoRepair')) { New-ItemProperty -LiteralPath $uninstallKey -Name $flag -Value 1 -PropertyType DWord -Force | Out-Null }
New-ItemProperty -LiteralPath $uninstallKey -Name 'EstimatedSize' -Value ([int]((Get-ChildItem -LiteralPath $base -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB)) -PropertyType DWord -Force | Out-Null
# Wait for the service to answer.
$healthy = $false
for ($i = 0; $i -lt 40 -and -not $healthy; $i++) {
    Start-Sleep -Milliseconds 500
    $health = & $node -e "require(process.argv[1]).status().then(s=>{if(s)console.log(s.version);process.exit(s?0:1)})" (Join-Path $app 'src\pc\client.cjs') 2>$null
    $healthy = ($LASTEXITCODE -eq 0)
}
if ($healthy) { Ok ('Local Voice ' + $health + ' is running. Its icon is in the taskbar tray (it may be under the ^ arrow).') }
else { Write-Host '  !   Local Voice did not answer yet. If no tray icon appears, open the tray menu > Diagnose, or see resident-error.log in %LOCALAPPDATA%\LocalVoice\resident.' -ForegroundColor Yellow }

# --- 6. Agents -----------------------------------------------------------------------------------------------------
Step '6/6  Coding agents (for talk-back)'
$list = (& $node (Join-Path $app 'scripts\agents.cjs') list --json) | ConvertFrom-Json
$found = @($list | Where-Object { $_.installed -or $_.connected })
if (-not $found.Count) { Info 'No supported agent found on this PC. Dictation works in any app; connect an agent later from the tray menu > Connect agents.' }
$wanted = @()
if ($Agents -notin @('ask', 'all', 'none')) { $wanted = $Agents.Split(',') | ForEach-Object { $_.Trim() } }
foreach ($agent in $found) {
    $label = $agent.name.PadRight(13)
    if ($agent.state -eq 'connected' -or $agent.state -eq 'needs-restart') { Ok ($label + 'already connected'); continue }
    $offer = 'Connect'; if ($agent.connected) { $offer = 'Repair the connection to' }
    if ($agent.state -eq 'needs-action' -and $agent.step) { Info ($label + $agent.detail); Info $agent.step; continue }
    $yes = $false
    if ($Agents -eq 'all') { $yes = $true }
    elseif ($Agents -eq 'ask') { $answer = Read-Host ('  ' + $offer + ' ' + $agent.name + '? [Y/n]'); $yes = ($answer -eq '' -or $answer -match '^[yY]') }
    else { $yes = $wanted -contains $agent.id }
    if (-not $yes) { Info ($label + 'not connected (connect later from the tray menu > Connect agents)'); continue }
    $result = (& $node (Join-Path $app 'scripts\agents.cjs') connect $agent.id --json) | ConvertFrom-Json
    if ($result.error) { Write-Host ('  X   ' + $agent.name + ': ' + $result.error) -ForegroundColor Red; continue }
    Ok ($label + 'connected')
    if ($result.step) { Write-Host ('      One step left in ' + $agent.name + ': ' + $result.step) -ForegroundColor Yellow }
    if ($result.state -eq 'needs-restart' -and $result.restart) { Write-Host ('      ' + $result.restart) -ForegroundColor Yellow }
}

Write-Host ''
Write-Host 'Local Voice is installed.' -ForegroundColor Green
Write-Host '  Ctrl+Shift+8  dictate          Ctrl+Shift+7  dictate with talk-back          Ctrl+Shift+6  cancel'
Write-Host '  Tray icon menu: Connect agents, Diagnose, Uninstall.'
Write-Host ('  To remove it later: Settings > Apps > Installed apps > Local Voice, or run "' + (Join-Path $app 'uninstall.cmd') + '".')
