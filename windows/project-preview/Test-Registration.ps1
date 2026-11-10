# SPDX-License-Identifier: AGPL-3.0-only
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$AssemblyPath)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Register-Preview.ps1'
$tokens = $null
$errors = $null
[Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
$plan = @(& $script -Action Plan -AssemblyPath $AssemblyPath)
if ($plan.Count -ne 12) { throw 'Unexpected registration plan entry count.' }
if (@($plan | Where-Object { $_.Path -match '\.(3mf|step|stp)' }).Count -ne 0) { throw 'Unrelated file type in plan.' }
$extension = @($plan | Where-Object { $_.Path -match '\\\.scanruler' })
if ($extension.Count -ne 1 -or $extension[0].Path -notmatch '\\shellex\\\{8895B1C6-') { throw 'Association defaults must not change.' }
foreach ($name in @('Class', 'Assembly', 'RuntimeVersion', 'CodeBase', 'ThreadingModel')) {
    if (@($plan | Where-Object { $_.Path -like '*\InprocServer32' -and $_.Name -eq $name }).Count -ne 1) {
        throw "Missing managed COM registration: $name"
    }
}
if (@($plan | Where-Object { $_.Name -eq '' -and $_.Value -eq 'mscoree.dll' }).Count -ne 1) { throw 'Missing CLR shim.' }
if (@($plan | Where-Object { $_.Name -eq 'DllSurrogate' -and $_.Value -like '*\System32\prevhost.exe' }).Count -ne 1) { throw 'Missing dedicated preview surrogate.' }
$machine = @(& $script -Action Plan -ComScope Machine -AssemblyPath $AssemblyPath)
$machineClass = @($machine | Where-Object { $_.Path -like 'HKLM\Software\Classes\*' })
if ($machine.Count -ne 12 -or $machineClass.Count -ne 10 -or
    @($machineClass | Where-Object { $_.Path -notmatch '\\(CLSID\\\{B7D14566-0509-4CCE-A71F-0A2B1A87B76B\}|AppID\\\{AE5AF77B-6FA1-4FF1-8C96-66938662D264\})' }).Count -ne 0) {
    throw 'Machine scope must place only this CLSID/AppID in HKLM.'
}
if (@($machine | Where-Object { $_.Path -match '\\\.scanruler' -and $_.Path -like 'HKLM*' }).Count -ne 0) { throw 'Machine scope changed the association hive.' }
$machineCode = ([Uri]@($machine | Where-Object { $_.Name -eq 'CodeBase' })[0].Value).LocalPath
if (-not $machineCode.StartsWith((Join-Path $env:ProgramFiles 'ScanRuler\ProjectPreview\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Machine COM DLL must be installed under Program Files.'
}
$blocked = $false
try { & $script -Action Register -AssemblyPath $AssemblyPath } catch { $blocked = $_.Exception.Message -like '*-AllowRegistryChanges*' }
if (-not $blocked) { throw 'Registration was not blocked without explicit consent.' }
$codebase = @($plan | Where-Object { $_.Name -eq 'CodeBase' })[0].Value
if ($codebase -notlike 'file:///*' -or $codebase.Contains('%')) { throw 'CodeBase must be an unescaped file URI.' }
$stableRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ScanRuler\ProjectPreview'
if (-not ([Uri]$codebase).LocalPath.StartsWith("$stableRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Registration depends on a nonpersistent build/session directory.'
}
. (Join-Path $PSScriptRoot 'InstallationState.ps1')
$testRoot = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($AssemblyPath))) ('install-test-' + [Guid]::NewGuid().ToString('N'))
try {
    $install = Get-PreviewInstallation $AssemblyPath $testRoot
    Install-PreviewAssembly $install
    if (-not $install.Created -or (Get-FileHash -LiteralPath $install.Path).Hash -cne $install.Hash) { throw 'Stable installation copy/hash failed.' }
    $existing = Get-PreviewInstallation $AssemblyPath $testRoot
    Install-PreviewAssembly $existing
    if ($existing.Created -or -not (Remove-OwnedPreviewAssembly $existing) -or -not (Test-Path -LiteralPath $install.Path)) {
        throw 'Preexisting identical file incorrectly owned/removed.'
    }
    [IO.File]::WriteAllText($install.Path, 'externally replaced')
    if (Remove-OwnedPreviewAssembly $install -WarningAction SilentlyContinue) { throw 'Externally changed file removed.' }
    $refused = $false
    try { Install-PreviewAssembly $existing } catch { $refused = $true }
    if (-not $refused) { throw 'Existing differing file overwritten.' }
    Copy-Item -LiteralPath $AssemblyPath -Destination $install.Path -Force
    if (-not (Remove-OwnedPreviewAssembly $install) -or (Test-Path -LiteralPath $install.Path)) { throw 'Owned unchanged installation not removed.' }
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
. (Join-Path $PSScriptRoot 'RegistrationState.ps1')
$values = @{
    restore = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = 'ours' }
    remove = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = 'ours' }
    changed = [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = 'another handler' }
    changedKind = [pscustomobject]@{ Exists = $true; Kind = 'ExpandString'; Value = 'ours' }
    absent = [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
    removed = [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
}
$entries = @()
foreach ($name in $values.Keys) {
    $beforeExists = $name -in @('restore', 'changed', 'changedKind', 'removed')
    $entries += [pscustomobject]@{
        Path = 'mock'; Name = $name; Value = 'ours'; Kind = 'String'
        Before = [pscustomobject]@{ Exists = $beforeExists; Kind = 'ExpandString'; Value = '%OLD%' }
    }
}
$remaining = @(Restore-PreviewEntries -Entries $entries `
    -ReadValue { param($Path, $Name) $values[$Name] } `
    -WriteValue { param($Path, $Name, $Value, $Kind) $values[$Name] = [pscustomobject]@{ Exists = $true; Value = $Value; Kind = $Kind } } `
    -RemoveValue { param($Path, $Name) $values.Remove($Name) } -WarningAction SilentlyContinue)
if ($values.restore.Value -cne '%OLD%' -or $values.restore.Kind -ne 'ExpandString') { throw 'Original value/type not restored.' }
if ($values.ContainsKey('remove')) { throw 'Owned newly created value not removed.' }
if ($remaining.Count -ne 3 -or $values.changed.Value -cne 'another handler' -or
    $values.changedKind.Kind -ne 'ExpandString' -or $values.removed.Exists) { throw 'External changes were not preserved.' }
Write-Output 'PASS stable installation copy/hash, no-overwrite and ownership cleanup; registration plan, PowerShell syntax, opt-in guard, and in-memory registry restoration (no registry access or changes).'
