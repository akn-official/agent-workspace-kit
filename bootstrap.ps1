# Fresh Windows PC -> full agent workspace (Claude Code skills, plugins, MCP servers, CLIs, apps).
# Run in normal (64-bit) PowerShell, NOT as admin. Public kit, one line:
#   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned; irm https://raw.githubusercontent.com/akn-official/agent-workspace-kit/main/bootstrap.ps1 | iex
# Private repo: download this file from github.com and run .\bootstrap.ps1
# Safe to re-run: every step skips what is already there.
$RepoSlug = 'akn-official/agent-workspace-kit'
$ErrorActionPreference = 'Continue'
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.local\bin" }

Step '1/6 Base tools (Git, Node, GitHub CLI, Python, Bun, uv, ripgrep, ffmpeg)'
foreach ($id in 'Git.Git','OpenJS.NodeJS.LTS','GitHub.cli','Python.Python.3.14','Oven-sh.Bun','astral-sh.uv','BurntSushi.ripgrep.MSVC','Gyan.FFmpeg.Essentials') {
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Write-Host "  $id"
}
Refresh-Path

Step '2/6 Claude Code CLI'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { irm https://claude.ai/install.ps1 | iex; Refresh-Path }
claude --version

Step "3/6 Get $RepoSlug"
$repo = "$HOME\" + ($RepoSlug -split '/')[1]
if (Test-Path "$repo\.git") { git -C $repo pull --ff-only }
else {
  git clone "https://github.com/$RepoSlug" $repo 2>$null
  if (-not (Test-Path "$repo\.git")) { # private repo: sign in first
    gh auth status 2>$null; if ($LASTEXITCODE -ne 0) { gh auth login --web --git-protocol https }
    gh repo clone $RepoSlug $repo
  }
}

Step '4/6 Apps (winget import; slow, skips what is missing)'
if (Test-Path "$repo\workspace\winget.json") { winget import -i "$repo\workspace\winget.json" --ignore-unavailable --ignore-versions --accept-package-agreements --accept-source-agreements }
$extra = (Get-Content "$repo\workspace\manifest.json" -Raw | ConvertFrom-Json).wingetExtra
foreach ($id in $extra) { winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null; Write-Host "  $id" }
Refresh-Path

Step '5/6 Personal rules and hooks (install.js, private repo only)'
if (Test-Path "$repo\install.js") { node "$repo\install.js" } else { Write-Host '  none in this kit' }

Step '6/6 Skills, plugins, MCP servers, CLIs (workspace.js restore)'
node "$repo\workspace.js" restore

Write-Host "`nDone. Close this window, open a new terminal, run 'claude', then /login. Guide: $repo\docs\workspace-guide.html" -ForegroundColor Green
