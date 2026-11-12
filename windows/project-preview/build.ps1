# SPDX-License-Identifier: AGPL-3.0-only
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'),
    [switch]$Test
)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4 x64 compiler not found.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$assembly = Join-Path $output 'ScanRuler.ProjectPreview.dll'
& $compiler /nologo /warnaserror+ /optimize+ /define:TRACE /platform:x64 /target:library `
    /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/out:$assembly" `
    (Join-Path $PSScriptRoot 'PreviewImage.cs') (Join-Path $PSScriptRoot 'PreviewHandler.cs')
if ($LASTEXITCODE -ne 0) { throw 'Preview handler compilation failed.' }
Write-Output "Built $assembly (x64 .NET Framework 4; no registration performed)."
if ($Test) {
    $tests = Join-Path $output 'ScanRuler.ProjectPreview.Tests.exe'
    & $compiler /nologo /warnaserror+ /optimize+ /define:TRACE /platform:x64 /target:exe `
        /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/reference:$assembly" `
        "/out:$tests" (Join-Path $PSScriptRoot 'Tests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Preview test compilation failed.' }
    & $tests
    if ($LASTEXITCODE -ne 0) { throw 'Preview handler tests failed.' }
    & (Join-Path $PSScriptRoot 'Test-Registration.ps1') -AssemblyPath $assembly
    if (-not $?) { throw 'Registration plan tests failed.' }
}
