# Helpers shared by setup, uninstall and install-resident (dot-source this file).
#
# Packaged (MSIX) apps such as the Claude desktop app give themselves, and every program started from their terminal,
# a private copy of %LOCALAPPDATA%: writes land in %LOCALAPPDATA%\Packages\<app>\LocalCache\Local. Local Voice installed
# from such a terminal is invisible to Windows itself, so the sign-in entry and the Start menu cannot start it.

# The packaged app whose private AppData this process writes to, or $null when %LOCALAPPDATA% is the real one.
# Writes a probe file and looks for it in each app's private copy.
function Get-AppDataRedirect([string]$Base = $env:LOCALAPPDATA) {
    $name = 'local-voice-probe-' + [guid]::NewGuid().ToString('N')
    $probe = Join-Path $Base $name
    try {
        Set-Content -LiteralPath $probe -Value 'probe'
        foreach ($package in (Get-ChildItem -LiteralPath (Join-Path $Base 'Packages') -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $package.FullName ('LocalCache\Local\' + $name))) { return $package.Name }
        }
        return $null
    } finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
}

# Opens a file through the Windows shell (Explorer), as a double-click would. The program it starts belongs to the
# desktop, not to this window: it sees the real AppData and keeps running when this window, or the app hosting it,
# closes. (A program started directly from here would share this window's sandbox and its job object.)
function Start-ViaShell([string]$Path) {
    & (Join-Path $env:SystemRoot 'explorer.exe') $Path
}

# Launchers from earlier runs whose window was closed before the launcher could delete itself: all but the running one.
function Remove-StaleLaunchers {
    Get-ChildItem -LiteralPath $env:TEMP -Filter 'local-voice-*.cmd' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ine $env:LOCAL_VOICE_LAUNCHER } | Remove-Item -Force -ErrorAction SilentlyContinue
}

# Re-runs a script in a new, ordinary PowerShell window opened through the shell, passing its arguments on.
# The temporary .cmd lives in %TEMP%, which packaged apps do not redirect, and deletes itself.
function Restart-OutsideSandbox([string]$Script, [string[]]$Arguments, [string]$App) {
    $cmd = Join-Path $env:TEMP ('local-voice-' + [IO.Path]::GetFileNameWithoutExtension($Script) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cmd')
    $quoted = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    @(
        '@echo off',
        'title Local Voice',
        'set "LOCAL_VOICE_LAUNCHER=%~f0"',
        ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $Script + '" ' + $quoted),
        'echo.',
        'pause',
        '(goto) 2>nul & del "%~f0"'
    ) | Set-Content -LiteralPath $cmd -Encoding ASCII
    Write-Host ''
    Write-Host ('This window runs inside an app (' + $App + ') that keeps its own private copy of AppData.') -ForegroundColor Yellow
    Write-Host 'Anything installed from here would be invisible to Windows, so Local Voice could not start at sign-in or from the Start menu.' -ForegroundColor Yellow
    Write-Host 'Continuing in a new PowerShell window...' -ForegroundColor Yellow
    Start-ViaShell $cmd
}
