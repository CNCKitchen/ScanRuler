# SPDX-License-Identifier: AGPL-3.0-only
function Get-PreviewInstallation {
    param([string]$Source, [string]$Root)
    $resolved = (Resolve-Path -LiteralPath $Source).ProviderPath
    $hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash
    [pscustomobject]@{
        Source = $resolved
        Path = Join-Path (Join-Path $Root $hash) 'ScanRuler.ProjectPreview.dll'
        Hash = $hash
        Created = $false
    }
}
function Install-PreviewAssembly {
    param($Installation)
    $destination = $Installation.Path
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne $Installation.Hash) {
            throw 'Existing installed assembly differs; refusing to overwrite.'
        }
        return
    }
    $directory = Split-Path -Parent $destination
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    try {
        # CreateNew avoids overwriting a file created concurrently.
        $input = [IO.File]::OpenRead($Installation.Source)
        try {
            $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $Installation.Created = $true
            try { $input.CopyTo($output) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -cne $Installation.Hash) {
            throw 'Installed assembly hash mismatch.'
        }
    } catch {
        if ($Installation.Created -and (Test-Path -LiteralPath $destination)) {
            Remove-Item -LiteralPath $destination
            $Installation.Created = $false
        }
        throw
    }
}
function Remove-OwnedPreviewAssembly {
    [CmdletBinding()]
    param($Installation)
    if (-not $Installation.Created -or -not (Test-Path -LiteralPath $Installation.Path)) { return $true }
    if ((Get-FileHash -LiteralPath $Installation.Path -Algorithm SHA256).Hash -cne $Installation.Hash) {
        Write-Warning 'Installed DLL changed externally; leaving it and the ownership backup untouched.'
        return $false
    }
    try { Remove-Item -LiteralPath $Installation.Path -ErrorAction Stop }
    catch {
        Write-Warning 'Installed DLL could not be removed (possibly in use); keep backup and retry unregister later.'
        return $false
    }
    $directory = Split-Path -Parent $Installation.Path
    if (@(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
        Remove-Item -LiteralPath $directory
    }
    return $true
}
