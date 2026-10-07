# Per-user launcher (login startup and the Start menu shortcut). Reads only the installation record beside this file.
$ErrorActionPreference = 'Stop'
try {
    # Single instance: do nothing if the resident recorded in endpoint.json is still running.
    $endpoint = Join-Path $PSScriptRoot 'endpoint.json'
    if (Test-Path -LiteralPath $endpoint) {
        $running = Get-Content -LiteralPath $endpoint -Raw | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$running.pid) -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -like '*resident.cjs*') { exit 0 }
    }
    $install = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'install.json') -Raw | ConvertFrom-Json
    $entry = Join-Path $install.root 'src\pc\resident.cjs'
    if (-not (Test-Path -LiteralPath $entry)) { throw 'Local Voice project was moved. Run install-resident.ps1 from its new location.' }
    # Node's native named mutex also prevents duplicate tray processes and model loads.
    Start-Process -FilePath $install.node -ArgumentList @(('"' + $entry + '"'),('"' + $install.root + '"'),('"' + $PSScriptRoot + '"')) -WorkingDirectory $install.root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'resident.log') -RedirectStandardError (Join-Path $PSScriptRoot 'resident-error.log')
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'startup-error.log')
}
