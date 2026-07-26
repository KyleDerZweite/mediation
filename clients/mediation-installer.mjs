#!/usr/bin/env node
// Dependency-free installer. It is deliberately also the installed uninstaller:
// keeping the mutation code in one place avoids divergent, destructive scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const marker = { toml: ['# >>> mediation >>>', '# <<< mediation <<<'], md: ['<!-- >>> mediation >>> -->', '<!-- <<< mediation <<< -->'] };
const argv = process.argv.slice(2);
const take = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const has = (name) => argv.includes(name);
const say = (...x) => { if (!has('--json')) console.error(...x); };
const fail = (message) => { throw new Error(message); };
const home = process.env.HOME || os.homedir();
const platform = process.platform;
const dataRoot = process.env.MEDIATION_HOME || (platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mediation')
  : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Mediation')
  : path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'mediation'));
const authRoot = process.env.MEDIATION_AUTH_HOME || (platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'mediation')
  : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'mediation')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'mediation'));
const manifestFile = path.join(dataRoot, 'install-manifest.json');
const clientFile = path.join(dataRoot, 'mediation-mcp.mjs');
const skillFile = path.join(dataRoot, 'SKILL.md');
const selfFile = path.join(dataRoot, 'mediation-installer.mjs');
const uninstallFile = path.join(dataRoot, platform === 'win32' ? 'uninstall.cmd' : 'uninstall.sh');
const supportedAgents = ['claude-code', 'codex', 'kimi-code', 'kimi-cli'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs() {
  const agents = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--agent') agents.push(argv[++i]);
  for (const a of agents) if (!supportedAgents.includes(a)) fail(`unknown agent: ${a}`);
  return { uninstall: has('--uninstall'), keepAuth: has('--keep-auth'), dry: has('--dry-run'), yes: has('--yes'), noLogin: has('--no-login'), all: has('--all'), agents, server: take('--server') };
}
function atomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  fs.writeFileSync(tmp, content, { mode });
  if (platform !== 'win32' || !fs.existsSync(file)) {
    fs.renameSync(tmp, file);
    return;
  }
  const backup = `${tmp}.bak`;
  fs.renameSync(file, backup);
  try { fs.renameSync(tmp, file); fs.rmSync(backup, { force: true }); }
  catch (error) { try { fs.renameSync(backup, file); } catch {} throw error; }
}
function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined; }
function snapshot(file) {
  return fs.existsSync(file) ? { content: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 } : null;
}
function restore(file, old) {
  if (!old) { fs.rmSync(file, { force: true }); return; }
  atomic(file, old.content);
  try { fs.chmodSync(file, old.mode); } catch {}
}
function validMarkers(text, [begin, end], file) {
  const b = text.split(begin).length - 1, e = text.split(end).length - 1;
  if (b !== e || b > 1) fail(`refusing malformed mediation markers in ${file}`);
  return b === 1;
}
function replaceBlock(text, pair, body, file) {
  const existing = validMarkers(text, pair, file);
  if (existing) text = text.slice(0, text.indexOf(pair[0])) + text.slice(text.indexOf(pair[1]) + pair[1].length);
  return `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${pair[0]}\n${body}\n${pair[1]}\n`;
}
function removeBlock(text, pair, file) {
  if (!validMarkers(text, pair, file)) return text;
  return (text.slice(0, text.indexOf(pair[0])) + text.slice(text.indexOf(pair[1]) + pair[1].length)).replace(/^\s+|\s+$/g, '') + '\n';
}
function jsonConfig(file, expected, remove = false, accepted = [expected]) {
  const raw = read(file); let obj = {};
  if (raw !== undefined) { try { obj = JSON.parse(raw); } catch { fail(`refusing malformed JSON: ${file}`); } }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object') fail(`refusing non-object JSON: ${file}`);
  if (obj.mcpServers !== undefined && (!obj.mcpServers || Array.isArray(obj.mcpServers) || typeof obj.mcpServers !== 'object')) fail(`refusing invalid mcpServers: ${file}`);
  const old = obj.mcpServers?.mediation;
  if (old && !accepted.some((entry) => JSON.stringify(old) === JSON.stringify(entry))) {
    fail(`refusing foreign or modified mediation MCP entry in ${file}`);
  }
  if (remove) { if (obj.mcpServers) delete obj.mcpServers.mediation; }
  else obj.mcpServers = { ...(obj.mcpServers || {}), mediation: expected };
  return JSON.stringify(obj, null, 2) + '\n';
}
function tomlConfig(file, expected, remove = false) {
  let text = read(file) || ''; validMarkers(text, marker.toml, file);
  // A non-marker table is owned by another tool/user and must never be replaced.
  if (/^\[mcp_servers\.mediation\]\s*$/m.test(text) && !text.includes(marker.toml[0])) fail(`refusing foreign mediation MCP entry in ${file}`);
  return remove ? removeBlock(text, marker.toml, file) : replaceBlock(text, marker.toml, expected, file);
}
function targetPaths(agent) {
  if (agent === 'codex') return [{ file: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), kind: 'toml' }, { file: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md'), kind: 'md' }, { skill: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'skills', 'mediation', 'SKILL.md') }];
  if (agent === 'claude-code') {
    const dir = process.env.CLAUDE_HOME || path.join(home, '.claude');
    return [{ file: path.join(dir, 'CLAUDE.md'), kind: 'md' }, { skill: path.join(dir, 'skills', 'mediation', 'SKILL.md') }];
  }
  const dir = agent === 'kimi-code' ? (process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code')) : (process.env.KIMI_SHARE_DIR || path.join(home, '.kimi'));
  return [{ file: path.join(dir, 'mcp.json'), kind: 'json' }, { skill: path.join(dir, 'skills', 'mediation', 'SKILL.md') }, ...(agent === 'kimi-code' ? [{ file: path.join(dir, 'AGENTS.md'), kind: 'md' }] : [])];
}
function detect() {
  const out = [];
  if (fs.existsSync(process.env.CLAUDE_HOME || path.join(home, '.claude')) || process.env.MEDIATION_TEST_CLAUDE) out.push('claude-code');
  if (fs.existsSync(process.env.CODEX_HOME || path.join(home, '.codex')) || process.env.MEDIATION_TEST_CODEX) out.push('codex');
  if (fs.existsSync(process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'))) out.push('kimi-code');
  if (fs.existsSync(process.env.KIMI_SHARE_DIR || path.join(home, '.kimi'))) out.push('kimi-cli');
  return out;
}
async function download(url) { const r = await fetch(url); if (!r.ok) fail(`download failed (${r.status}): ${url}`); return r.text(); }
function usage() {
  return '## Mediation\n\nFor coding tasks, the installed `mediation` skill is recommended for the full task so concurrent work and findings stay visible.\n\nIf the skill or service is unavailable, mention it once and continue.';
}
function expected(server, agent) {
  return { command: 'node', args: [clientFile], env: { MEDIATION_URL: server, MEDIATION_HARNESS: agent } };
}
function manifest() { try { return JSON.parse(read(manifestFile) || '{}'); } catch { fail(`refusing malformed install manifest: ${manifestFile}`); } }
function ensureSkill(file, source, prior) {
  const existing = read(file);
  if (existing !== undefined && !prior?.skills?.includes(file)
    && !/(^|\n)name:\s*mediation\s*($|\n)/.test(existing)) fail(`refusing foreign skill: ${file}`);
  return source;
}
async function install(opt) {
  if (!opt.server) fail('--server is required');
  let server; try { server = new URL(opt.server).origin; } catch { fail('invalid --server URL'); }
  let selected = opt.agents.length ? [...new Set(opt.agents)] : detect();
  if (!opt.agents.length && !opt.all && !opt.yes && process.stdin.isTTY && process.stderr.isTTY) {
    const choices = selected.map((x, i) => `${i + 1}:${x}`).join(', ');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`Install Mediation for ${choices} [all]: `)).trim();
    rl.close();
    if (answer) {
      const indexes = answer.split(/[ ,]+/).map(Number);
      if (indexes.some((n) => !Number.isInteger(n) || n < 1 || n > selected.length)) fail('invalid harness selection');
      selected = [...new Set(indexes.map((n) => selected[n - 1]))];
    }
  }
  if (!selected.length) fail('no supported agent harness found; pass --agent explicitly');
  const prior = manifest();
  selected = [...new Set([...(prior.agents || []), ...selected])];
  if (selected.includes('claude-code')) {
    const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (version.error || version.status !== 0) {
      fail('claude-code selected but the claude command is unavailable');
    }
    const found = spawnSync('claude', ['mcp', 'get', 'mediation'], { encoding: 'utf8' });
    const foundText = `${found.stdout || ''}\n${found.stderr || ''}`;
    if (found.status === 0 && !prior.claudeMcp && !foundText.includes(clientFile)) {
      fail('refusing foreign Claude MCP entry named mediation');
    }
  }
  const mcp = await download(`${server}/install/mediation-mcp.mjs`);
  const skill = await download(`${server}/install/SKILL.md`);
  if (!mcp.includes("serverInfo: { name: 'mediation'") || !skill.includes('name: mediation')) {
    fail('downloaded Mediation client or skill failed validation');
  }
  const uninstall = platform === 'win32'
    ? `@echo off\r\nnode "${selfFile}" --uninstall %*\r\n`
    : `#!/usr/bin/env sh\nexec node ${JSON.stringify(selfFile)} --uninstall "$@"\n`;
  const writes = new Map([[clientFile, mcp], [skillFile, skill],
    [selfFile, fs.readFileSync(new URL(import.meta.url), 'utf8')], [uninstallFile, uninstall]]);
  const ownedSkills = new Set(prior.skills || []);
  const configs = new Map((prior.configs || []).map((c) => [c.file, c]));
  for (const agent of selected) for (const t of targetPaths(agent)) {
    if (t.skill) { writes.set(t.skill, ensureSkill(t.skill, skill, prior)); ownedSkills.add(t.skill); continue; }
    const before = read(t.file) || ''; const body = t.kind === 'toml' ? `[mcp_servers.mediation]\ncommand = "node"\nargs = [${JSON.stringify(clientFile)}]\nenv = { MEDIATION_URL = ${JSON.stringify(server)} }` : usage();
    const oldAgent = configs.get(t.file)?.agent || agent;
    const oldServer = prior.server || server;
    if (t.kind === 'toml') {
      const tomlBody = `[mcp_servers.mediation]\ncommand = "node"\nargs = [${JSON.stringify(clientFile)}]\nenv = { MEDIATION_URL = ${JSON.stringify(server)}, MEDIATION_HARNESS = ${JSON.stringify(agent)} }`;
      writes.set(t.file, tomlConfig(t.file, tomlBody));
    } else if (t.kind === 'json') {
      const legacy = { command: 'node', args: [clientFile], env: { MEDIATION_URL: oldServer } };
      writes.set(t.file, jsonConfig(t.file, expected(server, agent), false,
        [expected(server, agent), expected(oldServer, oldAgent), legacy]));
    } else {
      writes.set(t.file, replaceBlock(before, marker.md, body, t.file));
    }
    configs.set(t.file, { file: t.file, kind: t.kind, agent });
  }
  const next = { version: 2, server, agents: selected, skills: [...ownedSkills],
    skillHashes: Object.fromEntries([...ownedSkills].map((file) => [file, sha256(writes.get(file))])),
    configs: [...configs.values()], claudeMcp: selected.includes('claude-code'), files: [...writes.keys()] };
  writes.set(manifestFile, JSON.stringify(next, null, 2) + '\n');
  if (opt.dry) { say(`would install for: ${selected.join(', ')}`); return { action: 'install', agents: selected, dryRun: true }; }
  const old = new Map([...writes.keys()].map((f) => [f, snapshot(f)]));
  let claudeChanged = false;
  try {
    for (const [file, content] of writes) atomic(file, content);
    if (selected.includes('claude-code')) {
      if (prior.claudeMcp) spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'mediation'], { stdio: 'ignore' });
      const added = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'mediation',
        '--env', `MEDIATION_URL=${server}`, '--env', 'MEDIATION_HARNESS=claude-code',
        '--', 'node', clientFile], { stdio: 'ignore' });
      if (added.status !== 0) fail('claude mcp add failed');
      claudeChanged = true;
    }
  } catch (e) {
    if (claudeChanged) spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'mediation'], { stdio: 'ignore' });
    if (prior.claudeMcp) {
      spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'mediation',
        '--env', `MEDIATION_URL=${prior.server}`, '--env', 'MEDIATION_HARNESS=claude-code',
        '--', 'node', clientFile], { stdio: 'ignore' });
    }
    for (const [file, content] of old) { try { restore(file, content); } catch {} }
    throw e;
  }
  try { fs.chmodSync(uninstallFile, 0o700); } catch {}
  return { action: 'install', agents: selected, dataRoot, authRoot, uninstall: uninstallFile,
    authenticated: fs.existsSync(path.join(authRoot, 'credentials.json')), loginRequired: !opt.noLogin };
}
function uninstall(opt) {
  const prior = manifest(); const files = prior.files || []; const skills = new Set(prior.skills || []); const writes = new Map();
  const authFile = path.join(authRoot, 'credentials.json');
  let deleteAuthFile = false;
  const configByFile = new Map((prior.configs || []).map((c) => [c.file, c]));
  for (const file of files) {
    if (file === clientFile || file === skillFile || file === selfFile || file === uninstallFile || file === manifestFile || skills.has(file)) continue;
    const kind = file.endsWith('.json') ? 'json' : file.endsWith('.toml') ? 'toml' : 'md'; const text = read(file); if (text === undefined) continue;
    const c = configByFile.get(file);
    const wanted = expected(prior.server, c?.agent || 'kimi-code');
    const legacy = { command: 'node', args: [clientFile], env: { MEDIATION_URL: prior.server } };
    writes.set(file, kind === 'json' ? jsonConfig(file, wanted, true, [wanted, legacy])
      : kind === 'toml' ? tomlConfig(file, '', true) : removeBlock(text, marker.md, file));
  }
  if (!opt.keepAuth) {
    const raw = read(authFile);
    if (raw !== undefined) {
      let credentials;
      try { credentials = JSON.parse(raw); } catch { fail(`refusing malformed credential file: ${authFile}`); }
      if (!credentials || Array.isArray(credentials) || typeof credentials !== 'object') {
        fail(`refusing invalid credential file: ${authFile}`);
      }
      if (prior.server) delete credentials[new URL(prior.server).origin];
      if (Object.keys(credentials).length) writes.set(authFile, JSON.stringify(credentials, null, 2) + '\n');
      else deleteAuthFile = true;
    }
  }
  if (opt.dry) return { action: 'uninstall', dryRun: true };
  const transactionFiles = new Set([...writes.keys(), ...(deleteAuthFile ? [authFile] : [])]);
  const old = new Map([...transactionFiles].map((f) => [f, snapshot(f)]));
  try {
    for (const [file, content] of writes) atomic(file, content);
    if (deleteAuthFile) fs.rmSync(authFile, { force: true });
    if (prior.claudeMcp && spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'mediation'], { stdio: 'ignore' }).status !== 0) {
      say('warning: could not remove the Claude MCP registration; remove it manually if Claude is reinstalled');
    }
  } catch (error) {
    for (const [file, content] of old) { try { restore(file, content); } catch {} }
    throw error;
  }
  for (const file of skills) {
    const current = read(file);
    const expectedHash = prior.skillHashes?.[file];
    if (current !== undefined && (!expectedHash || sha256(current) !== expectedHash)) {
      say(`preserved modified skill: ${file}`);
      continue;
    }
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  for (const file of [clientFile, skillFile, uninstallFile, selfFile, manifestFile]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return { action: 'uninstall', keptAuth: opt.keepAuth };
}
try { const opt = parseArgs(); const result = opt.uninstall ? uninstall(opt) : await install(opt); if (has('--json')) process.stdout.write(JSON.stringify(result) + '\n'); else say(`${result.action} complete`); }
catch (error) { console.error(`mediation installer: ${error.message}`); process.exitCode = 1; }
