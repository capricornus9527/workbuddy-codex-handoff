import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));

test('Windows PowerShell 5.1 parses both scripts and installs/upgrades/uninstalls without touching settings', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '中文 工作区');
  fs.mkdirSync(home);
  const settings = '{"autostart":false,"enabledPlugins":{"unrelated":false}}';
  fs.writeFileSync(path.join(home, 'settings.json'), settings);
  const ps = path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const check = path.join(root, 'parse.ps1');
  fs.writeFileSync(check, `param([string]$Repo)
foreach ($name in @('install.ps1','build.ps1')) {
  $tokens=$null; $errors=$null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Repo ('scripts/'+$name)),[ref]$tokens,[ref]$errors) > $null
  if ($errors.Count) { throw ($errors | Out-String) }
}
`);
  const run = args => {
    // Only this isolated child process; never change the user's execution policy.
    const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      encoding: 'utf8', timeout: 30000,
      // A parent PowerShell 7 may export its incompatible module directory.
      env: { ...process.env, PSModulePath: path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/Modules') },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run(['-File', check, '-Repo', repo]);
  const install = path.join(repo, 'scripts/install.ps1');
  const target = path.join(home, 'skills/codex-handoff');
  run(['-File', install, '-WorkBuddyHome', home, '-NodePath', process.execPath]);
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'runtime.json'), 'utf8')).version, version);
  for (const name of ['SKILL.md', 'scripts/handoff.mjs']) {
    assert.deepEqual(fs.readFileSync(path.join(target, name)), fs.readFileSync(path.join(repo, 'skills/codex-handoff', name)));
  }
  fs.writeFileSync(path.join(target, 'user-note.txt'), 'user edit to preserve');
  run(['-File', install, '-WorkBuddyHome', home, '-NodePath', process.execPath]);
  const backupRoot = path.join(home, 'codex-handoff-backups');
  const backups = fs.readdirSync(backupRoot);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(backupRoot, backups[0], 'user-note.txt'), 'utf8'), 'user edit to preserve');
  run(['-File', install, '-WorkBuddyHome', home, '-Uninstall']);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(backupRoot).length, 2);
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), settings);
});
