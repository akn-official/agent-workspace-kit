#!/usr/bin/env node
// Whole-workspace migration. Two commands:
//   node workspace.js snapshot          (old PC)  copies skills, research, memory, settings and tool lists into workspace/
//   node workspace.js restore [--dry]   (new PC)  installs all of it back. Idempotent; never deletes; existing folders are kept.
// Secrets are never copied: MCP headers/env become ${ENV_NAME} placeholders, .env/auth/credential files are skipped.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const H = os.homedir();
const REPO = __dirname;
const WS = path.join(REPO, 'workspace');
const CL = path.join(H, '.claude');
const DRY = process.argv.includes('--dry');
const log = (m) => console.log('  ' + m);
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
const tryRun = (cmd, opts) => {
  if (DRY) return log(`dry: ${cmd}`);
  try { sh(cmd, opts); log(`ok: ${cmd}`); return true; }
  catch (e) { log(`FAILED: ${cmd}\n      ${String(e.stderr || e.message).trim().split('\n').pop()}`); return false; }
};
const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Copy rules: no git/build/venv folders, no renders, no secrets, no file over 20 MB.
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'out', 'dist', '.next', '.cache']);
const SKIP_FILE = /^(\.env.*|auth\.json|\.credentials\.json|credentials.*\.json|.*\.(pem|key|p12|pfx))$/i;
const MAX = 20 << 20;
const skipped = [];
function copyTree(src, dst) {
  if (DRY) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.venv')) continue;
      copyTree(s, d);
    } else if (e.isFile()) {
      if (SKIP_FILE.test(e.name)) { skipped.push(s); continue; }
      if (fs.statSync(s).size > MAX) { skipped.push(s + ' (>20MB)'); continue; }
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}
const fresh = (d) => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }; // only on folders this script writes (workspace/, kit output)

// Paths in the snapshot are stored with the old home folder as %HOME% so they work under any user name.
const homeRe = new RegExp(H.replace(/[\\/]/g, '[\\\\/]+').replace(/[.]/g, '\\.'), 'gi');
const toHome = (s) => String(s).replace(homeRe, '%HOME%');
const fromHome = (s) => String(s).replace(/%HOME%/g, H.replace(/\\/g, '/'));

// ------------------------------------------------------------------ snapshot
function snapshot() {
  // a snapshot holds memory notes and personal skills: refuse to write one into a public repo
  try {
    if (sh(`gh repo view "${sh(`git -C "${REPO}" remote get-url origin`).trim()}" --json visibility --jq .visibility`).trim() === 'PUBLIC' && !process.argv.includes('--public-ok'))
      return console.log('This repo is PUBLIC. A snapshot holds your memory notes and personal skills. Use a private repo (or pass --public-ok).');
  } catch {} // no remote or no gh: local-only, fine
  const M = { takenAt: new Date().toISOString(), from: os.hostname() };
  fs.mkdirSync(WS, { recursive: true });

  console.log('Plugins + marketplaces');
  const known = readJson(path.join(CL, 'plugins', 'known_marketplaces.json'));
  M.marketplaces = Object.entries(known).map(([name, v]) => {
    const s = v.source;
    // the hyperframes marketplace was added from a local download of heygen-com/hyperframes (it has .claude-plugin/marketplace.json)
    const src = s.repo || (name === 'hyperframes' ? 'heygen-com/hyperframes' : s.url || s.path);
    return { name, source: src };
  });
  const inst = readJson(path.join(CL, 'plugins', 'installed_plugins.json'));
  M.plugins = Object.keys(inst.plugins || inst);
  log(`${M.marketplaces.length} marketplaces, ${M.plugins.length} plugins`);

  console.log('Claude settings (portable keys only)');
  const st = readJson(path.join(CL, 'settings.json'));
  const KEEP = ['model', 'effortLevel', 'modelSettings', 'theme', 'statusLine', 'enableWorkflows', 'autoUpdatesChannel',
    'skipDangerousModePermissionPrompt', 'skipWorkflowUsageWarning', 'switchModelsOnFlag', 'inputNeededNotifEnabled',
    'agentPushNotifEnabled', 'enabledPlugins'];
  M.settings = JSON.parse(toHome(JSON.stringify(Object.fromEntries(KEEP.filter((k) => k in st).map((k) => [k, st[k]])))));

  console.log('MCP servers (secrets replaced by ${ENV} placeholders)');
  const cj = readJson(path.join(H, '.claude.json'));
  M.mcp = {};
  for (const [name, v] of Object.entries(cj.mcpServers || {})) {
    if (name.startsWith('october')) continue; // the October app writes its own on install
    const ph = (o) => Object.fromEntries(Object.keys(o || {}).map((k) => [k, `\${${('MCP_' + name + '_' + k).toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`]));
    M.mcp[name] = JSON.parse(toHome(JSON.stringify({ ...v, env: ph(v.env), headers: ph(v.headers) })));
  }
  log(Object.keys(M.mcp).join(', '));

  console.log('Skills');
  const skillsDir = path.join(CL, 'skills');
  const gstackSub = new Set(ls(path.join(skillsDir, 'gstack')).filter((n) => fs.existsSync(path.join(skillsDir, 'gstack', n, 'SKILL.md'))));
  M.links = {}; M.gitSkills = {}; M.gstack = []; const vendored = [];
  const vdir = path.join(WS, 'claude', 'skills'); if (!DRY) fresh(vdir);
  for (const n of ls(skillsDir)) {
    const p = path.join(skillsDir, n);
    if (n.startsWith('.') || n === 'synced') continue; // .trash + claude.ai-synced skills (they re-sync on login)
    // links into this repo are re-made by install.js; links elsewhere (e.g. ~/.agents) are treated as the folder they point to
    if (isLink(p) && fs.realpathSync(p).startsWith(REPO)) { M.links[n] = toHome(fs.realpathSync(p)); continue; }
    const real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) continue;
    if (fs.existsSync(path.join(real, '.git'))) {
      try { M.gitSkills[n] = sh(`git -C "${real}" remote get-url origin`).trim(); continue; } catch {}
    }
    if (gstackSub.has(n) && n !== 'gstack') { M.gstack.push(n); continue; } // re-created by gstack ./setup
    copyTree(real, path.join(vdir, n)); vendored.push(n);
  }
  M.vendored = vendored;
  log(`${vendored.length} copied, ${Object.keys(M.gitSkills).length} git clones, ${M.gstack.length} from gstack setup, ${Object.keys(M.links).length} links`);

  // which skills each other agent had (all are copies of ones in ~/.claude/skills)
  M.agentSkills = {};
  for (const rel of ['.agents/skills', '.codex/skills', '.gemini/skills', '.qwen/skills', '.kiro/skills', '.continue/skills', '.config/opencode/skills']) {
    const names = ls(path.join(H, rel)).filter((n) => !n.startsWith('.'));
    if (names.length) M.agentSkills[rel] = names;
  }

  console.log('Folders: research, agents, memory, opencode agents, laya');
  const copies = [
    [path.join(CL, 'research'), 'claude/research'],
    [path.join(CL, 'agents'), 'claude/agents'],
    [path.join(H, '.config', 'opencode', 'agents'), 'opencode/agents'],
  ];
  for (const [src, rel] of copies) if (fs.existsSync(src)) { const d = path.join(WS, rel); if (!DRY) fresh(d); copyTree(src, d); log(rel); }
  for (const f of ['keybindings.json', 'statusline.ps1']) if (!DRY && fs.existsSync(path.join(CL, f))) { fs.mkdirSync(path.join(WS, 'claude'), { recursive: true }); fs.copyFileSync(path.join(CL, f), path.join(WS, 'claude', f)); }
  if (!DRY) { const d = path.join(WS, 'laya'); fresh(d); for (const f of ['laya_mcp.py', 'check.py']) if (fs.existsSync(path.join(H, '.laya', f))) fs.copyFileSync(path.join(H, '.laya', f), path.join(d, f)); }
  const memOut = path.join(WS, 'claude', 'memory'); if (!DRY) fresh(memOut);
  const homeKey = H.replace(/[:\\/ .]/g, '-');
  for (const proj of ls(path.join(CL, 'projects'))) {
    const mem = path.join(CL, 'projects', proj, 'memory');
    if (fs.existsSync(mem) && !/AppData/i.test(proj)) { copyTree(mem, path.join(memOut, proj.replace(new RegExp('^' + homeKey, 'i'), '%HOME%'))); log(`memory: ${proj}`); } // temp/scratch sessions skipped
  }

  console.log('Global tools');
  M.npm = Object.keys(JSON.parse(sh('npm ls -g --depth=0 --json')).dependencies || {}).filter((n) => n !== 'npm' && n !== 'corepack');
  M.pip = sh('python -m pip list --not-required --format=freeze').split(/\r?\n/).map((l) => l.split('==')[0]).filter((n) => n && !/^(pip|setuptools|wheel)$/i.test(n));
  try { M.uv = sh('uv tool list').split(/\r?\n/).filter((l) => l && !l.startsWith('-')).map((l) => l.split(' ')[0]); } catch { M.uv = []; }
  M.layaVenv = ['laya', 'mcp'];
  if (!DRY) {
    try { sh(`winget export -o "${path.join(WS, 'winget.json')}" --accept-source-agreements`); } catch {} // exits non-zero when some apps are not in winget; file is still written
  }
  // installed outside winget's export on this PC, ids checked with `winget show --id <id> -e` on 2026-11-03
  M.wingetExtra = ['Google.Chrome', 'Anysphere.Cursor', 'Gyan.FFmpeg.Essentials', 'astral-sh.uv', 'OBSProject.OBSStudio', 'Discord.Discord', 'Google.Antigravity', 'OpenAI.Codex'];
  M.manualApps = ['October (desktop)', 'Hermes (Nous Research)', 'DaVinci Resolve', 'Codex desktop app'];
  log(`npm ${M.npm.length}, pip ${M.pip.length}, uv ${M.uv.length}`);

  writeJson(path.join(WS, 'manifest.json'), M);
  if (!DRY) {
    try { process.stdout.write(sh(`python "${path.join(REPO, 'docs', 'build_catalog.py')}"`)); buildGuide(readJson(path.join(REPO, 'docs', 'catalog.json')), path.join(REPO, 'docs', 'workspace-guide.html')); }
    catch (e) { log(`guide not rebuilt: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }
  }
  if (skipped.length) { console.log('Skipped (secret-looking or too big):'); skipped.forEach((s) => log(toHome(s))); }
  console.log(`Snapshot written to ${WS}`);
}

// ------------------------------------------------------------------ restore
function restore() {
  const M = readJson(path.join(WS, 'manifest.json'), null);
  if (!M) { console.log('No workspace/manifest.json: run `node workspace.js snapshot` on the old PC first.'); return; }
  const has = (c) => { try { sh(`${c} --version`); return true; } catch { return false; } };

  console.log('Global tools');
  if (process.argv.includes('--no-tools')) log('skipped (--no-tools)');
  else if (has('npm')) for (const p of M.npm) tryRun(`npm install -g ${p}`);
  if (!process.argv.includes('--no-tools') && has('python')) tryRun(`python -m pip install --user ${M.pip.join(' ')}`);
  if (!process.argv.includes('--no-tools') && has('uv')) for (const t of M.uv) tryRun(`uv tool install ${t}`);

  console.log('Skills');
  const skillsDir = path.join(CL, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const n of M.vendored) {
    const d = path.join(skillsDir, n);
    if (fs.existsSync(d)) continue; // never overwrite a skill that is already there
    if (!DRY) copyTree(path.join(WS, 'claude', 'skills', n), d);
  }
  log(`${M.vendored.length} copied skills in place`);
  for (const [n, url] of Object.entries(M.gitSkills)) if (!fs.existsSync(path.join(skillsDir, n))) tryRun(`git clone --depth 1 ${url} "${path.join(skillsDir, n)}"`);
  if (fs.existsSync(path.join(skillsDir, 'gstack'))) { // needs Git Bash + Bun >= 1.4.2 (older Bun crashes in setup); makes /browse, /qa, /ship ...
    tryRun('bun upgrade');
    tryRun('bash ./setup', { cwd: path.join(skillsDir, 'gstack') });
  }
  for (const [n, target] of Object.entries(M.links)) {
    const link = path.join(skillsDir, n), t = fromHome(target);
    if (!fs.existsSync(link) && fs.existsSync(t) && !DRY) { fs.symlinkSync(t, link, 'junction'); log(`link ${n}`); }
  }
  for (const [rel, names] of Object.entries(M.agentSkills)) {
    const dir = path.join(H, rel);
    if (rel !== '.agents/skills' && !fs.existsSync(path.dirname(dir))) { log(`skip ${rel} (agent not installed)`); continue; }
    if (!DRY) fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const s of names) {
      const link = path.join(dir, s), t = path.join(skillsDir, s);
      if (!fs.existsSync(link) && fs.existsSync(t) && !DRY) { fs.symlinkSync(t, link, 'junction'); n++; }
    }
    log(`${rel}: ${n} new links`);
  }

  console.log('Folders');
  const back = [['claude/research', path.join(CL, 'research')], ['claude/agents', path.join(CL, 'agents')], ['opencode/agents', path.join(H, '.config', 'opencode', 'agents')], ['laya', path.join(H, '.laya')]];
  for (const [rel, dst] of back) if (fs.existsSync(path.join(WS, rel))) { copyTree(path.join(WS, rel), dst); log(`${rel} -> ${dst}`); }
  for (const f of ['keybindings.json', 'statusline.ps1']) { const s = path.join(WS, 'claude', f), d = path.join(CL, f); if (fs.existsSync(s) && !fs.existsSync(d) && !DRY) fs.copyFileSync(s, d); }
  const homeKey = H.replace(/[:\\/ .]/g, '-');
  for (const proj of ls(path.join(WS, 'claude', 'memory'))) copyTree(path.join(WS, 'claude', 'memory', proj), path.join(CL, 'projects', proj.replace('%HOME%', homeKey), 'memory'));
  log('memory restored (keyed to the same folder paths under your new user folder)');

  console.log('Claude settings');
  const sf = path.join(CL, 'settings.json');
  const cur = readJson(sf);
  const merged = { ...JSON.parse(fromHome(JSON.stringify(M.settings))), ...cur, enabledPlugins: { ...(M.settings.enabledPlugins || {}), ...(cur.enabledPlugins || {}) } };
  if (!DRY) writeJson(sf, merged);
  log('portable keys merged (your existing keys win)');

  if (!has('claude')) { console.log('claude CLI not found: install Claude Code, then re-run `node workspace.js restore`.'); return; }

  console.log('Plugin marketplaces + plugins');
  const known = Object.keys(readJson(path.join(CL, 'plugins', 'known_marketplaces.json')));
  for (const m of M.marketplaces) if (!known.includes(m.name)) tryRun(`claude plugin marketplace add ${m.source}`);
  const installed = Object.keys(readJson(path.join(CL, 'plugins', 'installed_plugins.json')).plugins || {});
  for (const p of M.plugins) if (!installed.includes(p)) tryRun(`claude plugin install ${p}`);

  console.log('MCP servers');
  const have = Object.keys(readJson(path.join(H, '.claude.json')).mcpServers || {});
  for (const [name, v0] of Object.entries(M.mcp)) {
    if (have.includes(name)) { log(`have ${name}`); continue; }
    const v = JSON.parse(fromHome(JSON.stringify(v0)));
    const fill = (o) => Object.entries(o || {}).map(([k, ph]) => [k, process.env[ph.slice(2, -1)]]);
    const missing = [...fill(v.env), ...fill(v.headers)].filter(([, val]) => !val).map(([k]) => k);
    if (missing.length) { log(`skip ${name}: set ${Object.values({ ...v.env, ...v.headers }).join(', ')} first`); continue; }
    if (name === 'laya' && !fs.existsSync(path.join(H, '.laya', 'venv'))) tryRun(`python -m venv "${path.join(H, '.laya', 'venv')}" && "${path.join(H, '.laya', 'venv', 'Scripts', 'python.exe')}" -m pip install ${M.layaVenv.join(' ')}`);
    const cfg = { type: v.type || 'stdio', command: v.command, args: v.args, url: v.url };
    for (const k of ['env', 'headers']) if (Object.keys(v[k] || {}).length) cfg[k] = Object.fromEntries(fill(v[k]));
    Object.keys(cfg).forEach((k) => cfg[k] === undefined && delete cfg[k]);
    tryRun(`claude mcp add-json -s user ${name} '${JSON.stringify(cfg)}'`, { shell: 'bash' });
  }
  console.log('Restore done. Open a new Claude Code session; sign in to figma/21st/etc. with /mcp where asked.');
}

// docs/guide.src.html + catalog -> one self-contained HTML page
function buildGuide(cat, outFile) {
  const src = fs.readFileSync(path.join(REPO, 'docs', 'guide.src.html'), 'utf8');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, src.replace('/*CATALOG*/null', () => JSON.stringify(cat).replace(/<\//g, '<\\/')));
}

// ------------------------------------------------------------------ kit (public copy for friends)
// node workspace.js kit <outDir>: builds a shareable repo from workspace/. Leaves out memory, research, personal/client
// skills, OpenCode agents and any skill without a known MIT/Apache source. Adds each upstream LICENSE under THIRD_PARTY/.
const PERSONAL = new Set([]); // add your own personal/client skill names here
function kit(out) {
  if (!out) return console.log('usage: node workspace.js kit <outDir>');
  const M = readJson(path.join(WS, 'manifest.json'), null);
  const cat = readJson(path.join(REPO, 'docs', 'catalog.json'), null);
  if (!M || !cat) return console.log('Run `node workspace.js snapshot` (and build docs/catalog.json) first.');
  const src = Object.fromEntries(cat.skills.map((s) => [s.name, s.source]));
  const repoOf = (s) => (/^[\w.-]+\/[\w.-]+/.exec(s || '') || [])[0];
  const okLicense = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
  const licenses = {}; const third = []; const kept = []; const left = [];
  const ow = path.join(out, 'workspace');
  fs.mkdirSync(ow, { recursive: true });
  for (const d of ['claude/skills', 'THIRD_PARTY']) fresh(path.join(d === 'THIRD_PARTY' ? out : ow, d));
  for (const n of M.vendored) {
    const dir = path.join(WS, 'claude', 'skills', n);
    const ownLicense = ls(dir).find((f) => /^licen[cs]e/i.test(f));
    const repo = repoOf(src[n]);
    let spdx = null;
    if (!PERSONAL.has(n) && repo) {
      if (!(repo in licenses)) {
        try { licenses[repo] = sh(`gh api repos/${repo} --jq ".license.spdx_id"`).trim(); } catch { licenses[repo] = 'NONE'; }
        if (okLicense.has(licenses[repo])) {
          try { fs.writeFileSync(path.join(out, 'THIRD_PARTY', repo.replace('/', '__') + '.LICENSE.txt'), sh(`gh api repos/${repo}/license -H "Accept: application/vnd.github.raw"`)); } catch {}
        }
      }
      spdx = licenses[repo];
    }
    if (!PERSONAL.has(n) && (okLicense.has(spdx) || (ownLicense && !repo))) {
      copyTree(dir, path.join(ow, 'claude', 'skills', n)); kept.push(n);
      third.push(`| ${n} | ${repo ? `[${repo}](https://github.com/${repo})` : 'license file in folder'} | ${spdx || 'see folder'} |`);
    } else left.push(n);
  }
  const P = { ...M, vendored: kept, links: {}, agentSkills: Object.fromEntries(Object.entries(M.agentSkills).map(([k, v]) => [k, v.filter((s) => !PERSONAL.has(s))])), from: 'AKN kit' };
  delete P.takenAt;
  writeJson(path.join(ow, 'manifest.json'), P);
  for (const f of ['winget.json', 'claude/agents', 'claude/keybindings.json', 'claude/statusline.ps1', 'laya']) {
    const s = path.join(WS, f), d = path.join(ow, f);
    if (!fs.existsSync(s)) continue;
    if (fs.statSync(s).isDirectory()) copyTree(s, d); else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
  }
  fs.writeFileSync(path.join(out, 'workspace.js'), fs.readFileSync(__filename, 'utf8').replace(/const PERSONAL = new Set\(\[[^\]]*\]\);/, "const PERSONAL = new Set([]); // add your own personal/client skill names here"));
  const slug = process.argv[4] || 'akn-official/agent-workspace-kit';
  fs.writeFileSync(path.join(out, 'bootstrap.ps1'), fs.readFileSync(path.join(REPO, 'bootstrap.ps1'), 'utf8').replace(/\$RepoSlug = '[^']*'/, `$RepoSlug = '${slug}'`));
  fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'docs', 'guide.src.html'), path.join(out, 'docs', 'guide.src.html'));
  const inKit = new Set([...kept, ...Object.keys(M.gitSkills), ...M.gstack]);
  const kcat = { ...cat, skills: cat.skills.filter((s) => inKit.has(s.name)) };
  writeJson(path.join(out, 'docs', 'catalog.json'), kcat);
  buildGuide(kcat, path.join(out, 'docs', 'workspace-guide.html'));
  fs.writeFileSync(path.join(out, 'THIRD_PARTY.md'), `# Third-party skills\n\nCopies of open-source skills, unchanged, kept so everyone gets the exact versions this kit was tested with. Each upstream license is in \`THIRD_PARTY/\`. All rights stay with their authors.\n\n| Skill | Source | License |\n|---|---|---|\n${third.join('\n')}\n`);
  fs.writeFileSync(path.join(out, 'README.md'), `# Agent workspace kit\n\nA ready-made Claude Code workspace for Windows, from AKN (Aspire Kinetic Network): ${M.plugins.length} plugins from ${M.marketplaces.length} marketplaces, ${kept.length + Object.keys(M.gitSkills).length + M.gstack.length} skills (design, SEO, video, research, orchestration), MCP servers (Playwright, Figma, 21st, laya, REA), and the CLI tools and apps they need.\n\n## Install (fresh or existing Windows PC)\n\nNormal PowerShell, not as admin:\n\n\`\`\`\nSet-ExecutionPolicy -Scope CurrentUser RemoteSigned\nirm https://raw.githubusercontent.com/${slug}/main/bootstrap.ps1 | iex\n\`\`\`\n\nIt installs Git, Node, Python, Bun, uv, ffmpeg and Claude Code, clones this repo, imports the apps in \`workspace/winget.json\`, then runs \`node workspace.js restore\`. Safe to re-run. It never overwrites a skill you already have.\n\nAfterwards: open a new terminal, run \`claude\`, \`/login\` with your own account. For the 21st MCP set your own key (\`setx MCP_21ST_X_API_KEY "..."\`) and re-run \`node workspace.js restore --no-tools\`; sign in to Figma with \`/mcp\`.\n\nFull guide and searchable catalog of every skill and plugin: \`docs/workspace-guide.html\` (download and open in a browser).\n\n## What is not here\n\nNo keys, logins, memory notes or personal/client skills. Third-party skills are unchanged copies of MIT/Apache-2.0 projects, listed with their sources in \`THIRD_PARTY.md\`.\n`);
  console.log(`Kit at ${out}: ${kept.length} skills copied, ${left.length} left out (personal or unknown license): ${left.join(', ')}`);
}

if (process.argv[2] === 'snapshot') snapshot();
else if (process.argv[2] === 'restore') restore();
else if (process.argv[2] === 'kit') kit(process.argv[3]);
else console.log('usage: node workspace.js snapshot | restore [--dry] [--no-tools] | kit <outDir>');
