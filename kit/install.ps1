# Installs the /portal skill for Claude Code: copies this folder (the kit) to %USERPROFILE%\.claude\skills\portal\.
# Run it again after the kit changes; it replaces the installed copy. Page folders (D:\portals\...) are not touched.
#
#   powershell -ExecutionPolicy Bypass -File kit\install.ps1
$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$target = Join-Path $env:USERPROFILE '.claude\skills\portal'

if (-not (Test-Path (Join-Path $source 'SKILL.md'))) { throw "No SKILL.md next to install.ps1 ($source)." }
if (Test-Path $target) {
    # only ever the skill's own folder, and only when it is this kit (or empty)
    if ((Get-ChildItem $target -Force | Measure-Object).Count -gt 0 -and -not (Test-Path (Join-Path $target 'SKILL.md'))) {
        throw "$target exists and is not the /portal skill; not replacing it."
    }
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Force $target | Out-Null

# everything but the checks' screenshots
Get-ChildItem $source -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\shots\\' } |
    ForEach-Object {
        $relative = $_.FullName.Substring($source.Length).TrimStart('\')
        $destination = Join-Path $target $relative
        New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
        Copy-Item $_.FullName $destination
    }

$count = (Get-ChildItem $target -Recurse -File | Measure-Object).Count
Write-Output "Installed the /portal skill: $count files in $target"
