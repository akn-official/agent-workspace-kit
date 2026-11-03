# Agent workspace kit

A ready-made Claude Code workspace for Windows, from AKN (Aspire Kinetic Network): 123 plugins from 14 marketplaces, 225 skills (design, SEO, video, research, orchestration), MCP servers (Playwright, Figma, 21st, laya, REA), and the CLI tools and apps they need.

## Install (fresh or existing Windows PC)

Normal PowerShell, not as admin:

```
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
irm https://raw.githubusercontent.com/akn-official/agent-workspace-kit/main/bootstrap.ps1 | iex
```

It installs Git, Node, Python, Bun, uv, ffmpeg and Claude Code, clones this repo, imports the apps in `workspace/winget.json`, then runs `node workspace.js restore`. Safe to re-run. It never overwrites a skill you already have.

Afterwards: open a new terminal, run `claude`, `/login` with your own account. For the 21st MCP set your own key (`setx MCP_21ST_X_API_KEY "..."`) and re-run `node workspace.js restore --no-tools`; sign in to Figma with `/mcp`.

Full guide and searchable catalog of every skill and plugin: `docs/workspace-guide.html` (download and open in a browser).

## What is not here

No keys, logins, memory notes or personal/client skills. Third-party skills are unchanged copies of MIT/Apache-2.0 projects, listed with their sources in `THIRD_PARTY.md`.
