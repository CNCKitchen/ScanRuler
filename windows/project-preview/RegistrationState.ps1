# SPDX-License-Identifier: AGPL-3.0-only
function Restore-PreviewEntries {
    [CmdletBinding()]
    param(
        [object[]]$Entries,
        [scriptblock]$ReadValue,
        [scriptblock]$WriteValue,
        [scriptblock]$RemoveValue
    )
    foreach ($entry in $Entries) {
        $current = & $ReadValue $entry.Path $entry.Name
        if ($current.Exists -and $current.Kind -eq $entry.Kind -and
            [string]$current.Value -ceq [string]$entry.Value) {
            if ($entry.Before.Exists) {
                & $WriteValue $entry.Path $entry.Name $entry.Before.Value $entry.Before.Kind
            } else { & $RemoveValue $entry.Path $entry.Name }
        } elseif ($current.Exists -or $entry.Before.Exists) {
            Write-Warning "Leaving externally changed or removed value: HKCU\$($entry.Path) [$($entry.Name)]"
            $entry
        }
    }
}
