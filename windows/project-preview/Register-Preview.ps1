# SPDX-License-Identifier: AGPL-3.0-only
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Plan', 'Register', 'Unregister')][string]$Action = 'Plan',
    [string]$AssemblyPath = (Join-Path $PSScriptRoot 'bin\ScanRuler.ProjectPreview.dll'),
    [string]$BackupPath,
    # With UAC disabled every process is elevated and COM ignores per-user
    # classes; Machine places only the handler CLSID/AppID in HKLM.
    [ValidateSet('User', 'Machine')][string]$ComScope = 'User',
    [switch]$AllowRegistryChanges
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'InstallationState.ps1')
$userRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ScanRuler\ProjectPreview'
$machineRoot = Join-Path $env:ProgramFiles 'ScanRuler\ProjectPreview'
$installRoot = if ($ComScope -eq 'Machine') { $machineRoot } else { $userRoot }
if (-not $BackupPath) { $BackupPath = Join-Path $userRoot 'registration-backup.clixml' }
$comPrefix = if ($ComScope -eq 'Machine') { 'HKLM\' } else { '' }
$clsid = '{B7D14566-0509-4CCE-A71F-0A2B1A87B76B}'
$appId = '{AE5AF77B-6FA1-4FF1-8C96-66938662D264}'
$classPath = "${comPrefix}Software\Classes\CLSID\$clsid"
$serverPath = "$classPath\InprocServer32"
$appPath = "${comPrefix}Software\Classes\AppID\$appId"
$extensionPath = 'Software\Classes\.scanruler\shellex\{8895B1C6-B41F-4C1C-A562-0D564250836F}'
$listPath = 'Software\Microsoft\Windows\CurrentVersion\PreviewHandlers'

function New-Entry($Path, $Name, $Value) {
    [pscustomobject]@{ Path = $Path; Name = $Name; Value = $Value; Kind = 'String' }
}
# mscoree fails with 0x80070002 on a percent-escaped CodeBase (e.g. %20 in Program Files),
# so write the RegAsm-style unescaped file URI.
function ConvertTo-CodeBase($Path) { 'file:///' + $Path.Replace('\', '/') }
function Get-Plan {
    $fullPath = (Resolve-Path -LiteralPath $AssemblyPath).ProviderPath
    $identity = [Reflection.AssemblyName]::GetAssemblyName($fullPath)
    if ($identity.Name -ne 'ScanRuler.ProjectPreview') { throw 'Wrong preview assembly identity.' }
    $installation = Get-PreviewInstallation $fullPath $installRoot
    $codebase = ConvertTo-CodeBase $installation.Path
    New-Entry $extensionPath '' $clsid
    New-Entry $classPath '' 'ScanRuler project saved-image preview'
    New-Entry $classPath 'AppID' $appId
    New-Entry $serverPath '' 'mscoree.dll'
    New-Entry $serverPath 'ThreadingModel' 'Apartment'
    New-Entry $serverPath 'Class' 'ScanRuler.ProjectPreview.PreviewHandler'
    New-Entry $serverPath 'Assembly' $identity.FullName
    New-Entry $serverPath 'RuntimeVersion' 'v4.0.30319'
    New-Entry $serverPath 'CodeBase' $codebase
    # Managed handlers require their own prevhost surrogate, not the shared AppID.
    New-Entry $appPath '' 'ScanRuler project preview isolated host'
    New-Entry $appPath 'DllSurrogate' (Join-Path $env:WINDIR 'System32\prevhost.exe')
    New-Entry $listPath $clsid 'ScanRuler project saved-image preview'
}

if ($Action -eq 'Plan') {
    Get-Plan
    return
}
if (-not $AllowRegistryChanges) { throw 'Explicit -AllowRegistryChanges is required. No registry changes made.' }
if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    throw 'Run this script in 64-bit Windows PowerShell for the x64 preview handler.'
}
$backup = [IO.Path]::GetFullPath($BackupPath)
if (-not $PSCmdlet.ShouldProcess(".scanruler preview handler only (COM scope $ComScope, 64-bit)", $Action)) { return }
$userHive = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$machineHive = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
# Paths prefixed HKLM\ are machine values; all others are HKCU.
function Assert-Administrator {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Machine COM scope requires an administrator PowerShell.'
    }
}
function Get-Hive($Path) { if ($Path.StartsWith('HKLM\')) { $machineHive } else { $userHive } }
function Get-SubPath($Path) { if ($Path.StartsWith('HKLM\')) { $Path.Substring(5) } else { $Path } }

function Get-RegistryValue($Path, $Name) {
    $key = (Get-Hive $Path).OpenSubKey((Get-SubPath $Path))
    try {
        $exists = $null -ne $key -and $key.GetValueNames() -contains $Name
        if ($exists) {
            [pscustomobject]@{
                Exists = $true
                Kind = $key.GetValueKind($Name).ToString()
                Value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            }
        } else { [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null } }
    } finally { if ($null -ne $key) { $key.Dispose() } }
}
function Set-RegistryValue($Path, $Name, $Value, $Kind) {
    $key = (Get-Hive $Path).CreateSubKey((Get-SubPath $Path))
    try { $key.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::$Kind) }
    finally { $key.Dispose() }
}
function Remove-RegistryValue($Path, $Name) {
    $key = (Get-Hive $Path).OpenSubKey((Get-SubPath $Path), $true)
    try { if ($null -ne $key) { $key.DeleteValue($Name, $false) } }
    finally { if ($null -ne $key) { $key.Dispose() } }
}
function Clear-CreatedKeys($Paths) {
    foreach ($path in @($Paths | Sort-Object { $_.Length } -Descending)) {
        $key = (Get-Hive $path).OpenSubKey((Get-SubPath $path))
        $empty = $false
        try { $empty = $null -ne $key -and $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0 }
        finally { if ($null -ne $key) { $key.Dispose() } }
        if ($empty) { (Get-Hive $path).DeleteSubKey((Get-SubPath $path), $false) }
    }
}
function Restore-Owned($State) {
    . (Join-Path $PSScriptRoot 'RegistrationState.ps1')
    $remaining = @(Restore-PreviewEntries -Entries $State.Entries `
        -ReadValue { param($Path, $Name) Get-RegistryValue $Path $Name } `
        -WriteValue { param($Path, $Name, $Value, $Kind) Set-RegistryValue $Path $Name $Value $Kind } `
        -RemoveValue { param($Path, $Name) Remove-RegistryValue $Path $Name })
    Clear-CreatedKeys $State.CreatedKeys
    $State.Entries = @($remaining)
    $removed = $false
    if ($remaining.Count -eq 0) { $removed = Remove-OwnedPreviewAssembly $State.Installation }
    if ($remaining.Count -eq 0 -and $removed) { Remove-Item -LiteralPath $backup }
    else { $State | Export-Clixml -LiteralPath $backup }
}

try {
    if ($Action -eq 'Unregister') {
        $state = Import-Clixml -LiteralPath $backup
        if ($state.Owner -ne $clsid -or $state.Schema -notin @(2, 3)) { throw 'Not this handler registration backup.' }
        # Scope comes from the backup, never from the current command line.
        $stateScope = if ($state.Schema -eq 2) { 'User' } else { $state.ComScope }
        if ($stateScope -notin @('User', 'Machine')) { throw 'Unexpected COM scope in backup.' }
        $stateRoot = if ($stateScope -eq 'Machine') { $machineRoot } else { $userRoot }
        $statePrefix = if ($stateScope -eq 'Machine') { 'HKLM\' } else { '' }
        $expectedDll = Join-Path (Join-Path $stateRoot $state.Installation.Hash) 'ScanRuler.ProjectPreview.dll'
        if ($state.Installation.Hash -notmatch '^[A-F0-9]{64}$' -or
            $state.Installation.Path -cne $expectedDll) { throw 'Unexpected installation path in backup.' }
        if ($stateScope -eq 'Machine') { Assert-Administrator }
        $stateClass = "${statePrefix}Software\Classes\CLSID\$clsid"
        $allowedPaths = @($extensionPath, $stateClass, "$stateClass\InprocServer32",
            "${statePrefix}Software\Classes\AppID\$appId", $listPath)
        foreach ($entry in $state.Entries) {
            if ($entry.Path -notin $allowedPaths) { throw 'Unexpected registry path in backup.' }
        }
        foreach ($path in $state.CreatedKeys) {
            if (-not ($allowedPaths | Where-Object { $_ -eq $path -or $_.StartsWith("$path\", [StringComparison]::OrdinalIgnoreCase) })) {
                throw 'Unexpected created key in backup.'
            }
        }
        Restore-Owned $state
        Write-Output 'Unregistration finished; changed third-party values, if any, were left untouched.'
        return
    }
    if (Test-Path -LiteralPath $backup) { throw 'Backup already exists. Unregister using it before registering again.' }
    if ($ComScope -eq 'Machine') { Assert-Administrator }
    $plan = @(Get-Plan)
    $created = @()
    $entries = @()
    foreach ($entry in $plan) {
        $entry | Add-Member -NotePropertyName Before -NotePropertyValue (Get-RegistryValue $entry.Path $entry.Name)
        $entries += $entry
        $path = $entry.Path
        while ((Get-SubPath $path).StartsWith('Software\', [StringComparison]::OrdinalIgnoreCase)) {
            $key = (Get-Hive $path).OpenSubKey((Get-SubPath $path))
            if ($null -ne $key) { $key.Dispose(); break }
            if ($created -notcontains $path) { $created += $path }
            $path = $path.Substring(0, $path.LastIndexOf('\'))
        }
    }
    $installation = Get-PreviewInstallation $AssemblyPath $installRoot
    $plannedCodebase = @($plan | Where-Object { $_.Name -eq 'CodeBase' })[0].Value
    if ($plannedCodebase -cne (ConvertTo-CodeBase $installation.Path)) {
        throw 'Source DLL changed while preparing registration. Retry with a stable build.'
    }
    $state = [pscustomobject]@{ Schema = 3; ComScope = $ComScope; Owner = $clsid; Entries = $entries; CreatedKeys = $created; Installation = $installation }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $backup)) | Out-Null
    # Persist every overwritten value before the first registry write.
    $state | Export-Clixml -LiteralPath $backup -NoClobber
    try {
        Install-PreviewAssembly $installation
        $state | Export-Clixml -LiteralPath $backup
        foreach ($entry in $entries) { Set-RegistryValue $entry.Path $entry.Name $entry.Value $entry.Kind }
    } catch {
        Write-Warning 'Registration failed; attempting ownership-checked rollback. Keep the backup if rollback fails.'
        Restore-Owned $state
        throw
    }
    Write-Output "Registered .scanruler preview only (association/list HKCU, COM class $ComScope). Persistent DLL: $($installation.Path). Keep restoration backup: $backup"
} finally { $userHive.Dispose(); $machineHive.Dispose() }
