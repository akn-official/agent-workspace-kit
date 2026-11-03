# Claude Code allows one statusLine command, and both ponytail and caveman ship a badge.
# This runs each plugin's own script rather than reimplementing it, so an upgrade to either
# plugin changes the badge without touching this file.
#
# Both scripts render with [Console]::Write, which bypasses the PowerShell pipeline and goes
# straight to our stdout -- so they cannot be captured into a variable, only run in order.
# That is why the separator is decided from the flag files instead of from their output.
#
# Each script exits silently when its mode is off, so an inactive plugin costs nothing.

$ErrorActionPreference = 'SilentlyContinue'

$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }

function Find-Badge($Pattern) {
    # Plugin paths carry a version segment, so glob it and take the newest match; pinning
    # the version here would silently blank the badge on the next plugin upgrade.
    (Resolve-Path (Join-Path $ClaudeDir $Pattern) -ErrorAction SilentlyContinue |
        Sort-Object Path -Descending | Select-Object -First 1).Path
}

$Ponytail = Find-Badge 'plugins\cache\ponytail\ponytail\*\hooks\ponytail-statusline.ps1'
$Caveman  = Find-Badge 'plugins\cache\caveman\caveman\*\src\hooks\caveman-statusline.ps1'

$BothOn = (Test-Path (Join-Path $ClaudeDir '.ponytail-active')) -and
          (Test-Path (Join-Path $ClaudeDir '.caveman-active'))

if ($Ponytail) { & $Ponytail }
if ($BothOn)   { [Console]::Write(' ') }
if ($Caveman)  { & $Caveman }
