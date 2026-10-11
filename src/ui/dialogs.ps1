# Local Voice tray windows: Connect agents, Diagnose and Uninstall. Started by the tray (src/pc/resident.cjs) with no
# console window. All work is done by the app's own scripts, run with Local Voice's Node.js runtime.
param([ValidateSet('agents', 'diagnose', 'uninstall')][string]$Mode = 'agents', [string]$Node, [string]$Root)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$bold = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)

# Runs one of the app's scripts and returns its standard output (UTF-8).
function Invoke-App([string[]]$arguments) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Node
    $info.Arguments = (@((Join-Path $Root $arguments[0])) + $arguments[1..($arguments.Count - 1)] | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8; $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $info.WorkingDirectory = $env:TEMP
    $p = [System.Diagnostics.Process]::Start($info)
    $errTask = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
    if (-not $out.Trim() -and $errTask.Result) { return $errTask.Result }
    return $out
}
function New-Form([string]$title, [int]$w, [int]$h) {
    $f = New-Object System.Windows.Forms.Form
    $f.Text = $title; $f.Font = $font; $f.StartPosition = 'CenterScreen'; $f.TopMost = $true
    $f.ClientSize = New-Object System.Drawing.Size($w, $h); $f.MinimizeBox = $false; $f.MaximizeBox = $false
    $f.FormBorderStyle = 'FixedDialog'
    # The tray starts PowerShell with a hidden console, and Windows applies that "hidden" to the first window shown.
    # Opening minimized and restoring once shown makes the form visible.
    $f.Add_Load({ $this.WindowState = 'Minimized' })
    $f.Add_Shown({ $this.WindowState = 'Normal'; $this.Activate(); $this.TopMost = $false })
    return $f
}
function New-Button([string]$text, [int]$x, [int]$y, [int]$w = 110) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, 30)
    return $b
}

# --- Connect agents ------------------------------------------------------------------------------------------------
function Show-Agents {
    $form = New-Form 'Local Voice - Connect agents' 700 560
    $intro = New-Object System.Windows.Forms.Label
    $intro.Text = 'Connect Local Voice to your coding agents so that replies to messages you dictate with talk-back (Ctrl+Shift+7) are read aloud. Dictation itself works in every app without connecting anything.'
    $intro.Location = New-Object System.Drawing.Point(16, 12); $intro.Size = New-Object System.Drawing.Size(668, 40)
    $form.Controls.Add($intro)
    $panel = New-Object System.Windows.Forms.FlowLayoutPanel
    $panel.Location = New-Object System.Drawing.Point(12, 58); $panel.Size = New-Object System.Drawing.Size(676, 446)
    $panel.FlowDirection = 'TopDown'; $panel.WrapContents = $false; $panel.AutoScroll = $true; $panel.BorderStyle = 'FixedSingle'
    $form.Controls.Add($panel)
    $refresh = New-Button 'Refresh' 16 516; $form.Controls.Add($refresh)
    $close = New-Button 'Close' 578 516; $close.DialogResult = 'Cancel'; $form.Controls.Add($close); $form.CancelButton = $close
    $status = New-Object System.Windows.Forms.Label
    $status.Location = New-Object System.Drawing.Point(136, 522); $status.Size = New-Object System.Drawing.Size(430, 24); $status.ForeColor = [System.Drawing.Color]::DimGray
    $form.Controls.Add($status)

    $labels = @{ 'not-installed' = @('Not installed', 'Gray'); 'not-connected' = @('Installed - not connected', 'DimGray'); 'connected' = @('Connected', 'ForestGreen'); 'needs-restart' = @('Connected - needs restart', 'DarkOrange'); 'needs-action' = @('Needs action', 'Firebrick') }
    $script:act = $null
    $load = {
        $status.Text = 'Checking which agents are on this PC...'; $form.Cursor = 'WaitCursor'; [System.Windows.Forms.Application]::DoEvents()
        $raw = Invoke-App @('scripts\agents.cjs', 'list', '--json')
        $form.Cursor = 'Default'; $status.Text = ''
        $panel.SuspendLayout(); $panel.Controls.Clear()
        try { $list = $raw | ConvertFrom-Json } catch { $status.Text = 'Could not list agents: ' + $raw; $panel.ResumeLayout(); return }
        # Agents found on this PC first, then the others.
        $ordered = @($list | Where-Object { $_.installed -or $_.connected }) + @($list | Where-Object { -not ($_.installed -or $_.connected) })
        foreach ($a in $ordered) {
            $row = New-Object System.Windows.Forms.Panel
            $row.Size = New-Object System.Drawing.Size(650, 10); $row.Margin = New-Object System.Windows.Forms.Padding(4, 4, 4, 4)
            $name = New-Object System.Windows.Forms.Label
            $name.Text = $a.name; $name.Font = $bold; $name.Location = New-Object System.Drawing.Point(6, 6); $name.Size = New-Object System.Drawing.Size(150, 22)
            $state = New-Object System.Windows.Forms.Label
            $state.Text = $labels[$a.state][0]; $state.ForeColor = [System.Drawing.Color]::FromName($labels[$a.state][1])
            $state.Location = New-Object System.Drawing.Point(160, 7); $state.Size = New-Object System.Drawing.Size(250, 22)
            $row.Controls.AddRange(@($name, $state))
            $details = @()
            if ($a.state -ne 'not-installed' -and $a.state -ne 'not-connected' -and $a.state -ne 'connected' -and $a.detail) { $details += $a.detail }
            if ($a.step) { $details += $a.step }
            if ($a.state -eq 'needs-restart' -and $a.restart) { $details += $a.restart }
            $height = 36
            if ($details.Count) {
                $info = New-Object System.Windows.Forms.Label
                $info.Text = $details -join "`r`n"; $info.Location = New-Object System.Drawing.Point(6, 32)
                $info.MaximumSize = New-Object System.Drawing.Size(630, 0); $info.AutoSize = $true
                $row.Controls.Add($info); $height = 40 + $info.PreferredHeight
            }
            $buttons = @()
            if ($a.state -eq 'not-connected' -or ($a.state -eq 'needs-action' -and -not $a.step)) { $buttons += ,@('Connect', 'connect') }
            if ($a.connected) { $buttons += ,@('Disconnect', 'disconnect') }
            $x = 540
            foreach ($spec in $buttons) {
                $b = New-Button $spec[0] $x 2 100; $b.Tag = @($spec[1], $a.id, $a.name)
                $b.Add_Click({ $script:act = $this.Tag; $form.Tag = 'act' ; $timer.Start() })
                $row.Controls.Add($b); $x -= 106
            }
            if ($a.state -eq 'not-installed') { $name.ForeColor = [System.Drawing.Color]::Gray }
            $row.Height = $height
            $panel.Controls.Add($row)
        }
        $panel.ResumeLayout()
    }
    # Work runs from a timer tick, so the click returns and the window repaints first.
    $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 50
    $timer.Add_Tick({
        $timer.Stop()
        if ($script:act) {
            $what, $id, $label = $script:act; $script:act = $null
            $verb = 'Connecting'; if ($what -eq 'disconnect') { $verb = 'Disconnecting' }
            $status.Text = $verb + ' ' + $label + '...'; $form.Cursor = 'WaitCursor'; $panel.Enabled = $false; [System.Windows.Forms.Application]::DoEvents()
            $raw = Invoke-App @('scripts\agents.cjs', $what, $id, '--json')
            $form.Cursor = 'Default'; $panel.Enabled = $true
            try { $r = $raw | ConvertFrom-Json } catch { $r = [pscustomobject]@{ error = $raw } }
            if ($r -is [array]) { $r = $r[0] }
            if ($r.error) { [void][System.Windows.Forms.MessageBox]::Show($form, $r.error, 'Local Voice - ' + $label, 'OK', 'Warning') }
            elseif ($what -eq 'connect') {
                $message = $label + ' is connected.'
                if ($r.step) { $message += "`r`n`r`nOne more step in " + $label + ":`r`n" + $r.step }
                if ($r.state -eq 'needs-restart' -and $r.restart) { $message += "`r`n`r`n" + $label + ' is running and loads the hook only after a restart:' + "`r`n" + $r.restart }
                elseif (-not $r.step) { $message += "`r`n`r`nNew conversations in " + $label + ' use it. Dictate with Ctrl+Shift+7 to hear the reply.' }
                [void][System.Windows.Forms.MessageBox]::Show($form, $message, 'Local Voice - ' + $label, 'OK', 'Information')
            } else {
                $message = $label + ' is disconnected; its settings are back as they were.'
                if ($r.ok -eq $false) { $message = $label + ': the hook was removed, but the file differs from the copy saved before Local Voice changed it. That copy was kept beside it (.local-voice.bak).' }
                [void][System.Windows.Forms.MessageBox]::Show($form, $message, 'Local Voice - ' + $label, 'OK', 'Information')
            }
        }
        & $load
    })
    $refresh.Add_Click({ $timer.Start() })
    $form.Add_Shown({ $timer.Start() })
    [void]$form.ShowDialog()
}

# --- Diagnose ------------------------------------------------------------------------------------------------------
function Show-Diagnose {
    $form = New-Form 'Local Voice - Diagnose' 720 520
    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.WordWrap = $true
    $box.Font = New-Object System.Drawing.Font('Consolas', 9.5); $box.BackColor = [System.Drawing.Color]::White
    $box.Location = New-Object System.Drawing.Point(12, 12); $box.Size = New-Object System.Drawing.Size(696, 452)
    $form.Controls.Add($box)
    $again = New-Button 'Check again' 12 476; $copy = New-Button 'Copy' 128 476
    $close = New-Button 'Close' 598 476; $close.DialogResult = 'Cancel'; $form.CancelButton = $close
    $form.Controls.AddRange(@($again, $copy, $close))
    $timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 50
    $timer.Add_Tick({
        $timer.Stop(); $box.Text = 'Checking the models, the service, the hotkeys and each connected agent...'; $form.Cursor = 'WaitCursor'; [System.Windows.Forms.Application]::DoEvents()
        $box.Text = ((Invoke-App @('scripts\diagnose.cjs')) -replace "`r?`n", "`r`n"); $box.SelectionStart = 0; $form.Cursor = 'Default'
    })
    $again.Add_Click({ $timer.Start() }); $copy.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($box.Text) })
    $form.Add_Shown({ $timer.Start() })
    [void]$form.ShowDialog()
}

# --- Uninstall -----------------------------------------------------------------------------------------------------
# The uninstaller asks, shows its progress and the summary itself, so the tray, Settings > Apps and uninstall.cmd all
# open the same windows. It must run as its own process: it stops the service, which ends this one. The copy that setup
# placed in %LOCALAPPDATA%\LocalVoice\uninstaller is used, the app's own copy only if that is missing.
function Show-Uninstall {
    $script = Join-Path $env:LOCALAPPDATA 'LocalVoice\uninstaller\uninstall.ps1'
    if (-not (Test-Path -LiteralPath $script)) { $script = Join-Path $Root 'scripts\uninstall.ps1' }
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $script + '"'), '-Gui') -WorkingDirectory $env:TEMP -WindowStyle Hidden
}

try {
    switch ($Mode) { 'agents' { Show-Agents } 'diagnose' { Show-Diagnose } 'uninstall' { Show-Uninstall } }
} catch {
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Local Voice', 'OK', 'Error')
}
