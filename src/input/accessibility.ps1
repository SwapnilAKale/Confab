# Read-only UI Automation; loads installed assemblies, does not compile code.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
function Reject-Field($element, $detail) {
    $observed = @{detail=$detail}
    if ($null -ne $element) { $observed.type=$element.Current.ControlType.ProgrammaticName; $observed.focused=$element.Current.HasKeyboardFocus; $observed.enabled=$element.Current.IsEnabled; $observed.password=$element.Current.IsPassword; $observed.processId=$element.Current.ProcessId }
    return @{status='rejected'; reason='not_editable'; observed=$observed}
}
function Read-FocusedField($request) {
    $element = [Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $element -or -not $element.Current.HasKeyboardFocus -or -not $element.Current.IsEnabled -or $element.Current.IsPassword) { return (Reject-Field $element 'focus-enabled-password-check') }
    $valuePattern = $null
    $textPattern = $null
    $hasValue = $element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)
    if ($hasValue) {
        if ($valuePattern.Current.IsReadOnly) { return (Reject-Field $element 'read-only-value') }
    } else {
        $control = $element.Current.ControlType
        if (($control -ne [Windows.Automation.ControlType]::Edit -and $control -ne [Windows.Automation.ControlType]::Document) -or -not $element.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) { return (Reject-Field $element 'no-editable-pattern') }
    }
    $runtimeId = $element.GetRuntimeId() -join ','
    if ($request.runtimeId -and $request.runtimeId -ne $runtimeId) { return @{status='rejected'; reason='field_changed'} }
    $top = $element
    $document = $null
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth=0; $depth -lt 64; $depth++) {
        $parent = $walker.GetParent($top)
        if ($null -eq $parent -or $parent.Equals([Windows.Automation.AutomationElement]::RootElement)) { break }
        # Nearest containing document: a browser tab or Electron page (its name is the page/session title).
        if ($null -eq $document -and $parent.Current.ControlType -eq [Windows.Automation.ControlType]::Document) { $document = $parent }
        $top = $parent
    }
    $result = @{status='editable'; runtimeId=$runtimeId; window=[string]$top.Current.NativeWindowHandle; processId=$element.Current.ProcessId}
    if ($null -ne $document) { $result.documentId = $document.GetRuntimeId() -join ','; $name = [string]$document.Current.Name; $result.documentName = if ($name.Length -gt 300) { $name.Substring(0,300) } else { $name } }
    if ($request.includeText) {
        if ($hasValue) { $result.value = $valuePattern.Current.Value } else { $result.value = $textPattern.DocumentRange.GetText(60000) }
    }
    return $result
}
[Console]::WriteLine('{"eventName":"ready"}')
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        if ($line.Length -gt 131072) { throw 'Request too large' }
        $request = $line | ConvertFrom-Json
        if ($request.action -ne 'snapshot') { throw 'Unsupported request' }
        $result = Read-FocusedField $request
        [Console]::WriteLine((@{id=$request.id; result=$result} | ConvertTo-Json -Compress -Depth 5))
    } catch {
        [Console]::WriteLine((@{id=$request.id; result=@{status='rejected'; reason='accessibility_unavailable'}} | ConvertTo-Json -Compress))
    }
}
