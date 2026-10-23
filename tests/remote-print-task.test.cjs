const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hidden receiver launcher waits for Node, preserves exit status and previous diagnostics', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote print launcher '));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    const config = path.join(directory, 'agent.json');
    fs.writeFileSync(config, '{}');
    fs.writeFileSync(path.join(directory, 'scripts/remote-print-agent.cjs'), `
      const fs = require('node:fs');
      if (!fs.existsSync(process.argv[2])) process.exit(90);
      console.log('receiver fixture started');
      console.error('receiver fixture failure');
      setTimeout(() => process.exit(7), 150);
    `);
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/run-remote-print-agent.ps1'), '-ConfigFile', config, '-NodeExe', process.execPath], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    for (let i = 0; i < 2; i++) {
      const result = run();
      assert.equal(result.status, 7, result.stderr || result.error?.message);
      assert.match(fs.readFileSync(path.join(directory, 'receiver.log'), 'utf8'), /receiver fixture started/);
      assert.match(fs.readFileSync(path.join(directory, 'receiver-error.log'), 'utf8'), /receiver fixture failure/);
    }
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('receiver.log.')).length, 1);
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('receiver-error.log.')).length, 1);
    const lifecycle = fs.readFileSync(path.join(directory, 'supervisor.log'), 'utf8');
    assert.equal((lifecycle.match(/receiver exited: 7/g) || []).length, 2);
    assert.equal(fs.readFileSync(config, 'utf8'), '{}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('launcher adopts an orphaned receiver before rotating its logs or starting another', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote orphan receiver '));
  let child;
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    const config = path.join(directory, 'agent.json');
    fs.writeFileSync(config, '{}');
    const agent = path.join(directory, 'scripts/remote-print-agent.cjs');
    fs.writeFileSync(agent, `
      const fs=require('node:fs'),path=require('node:path');
      const dir=path.dirname(process.argv[2]),lock=path.join(dir,'agent.lock');
      const first=!fs.existsSync(path.join(dir,'original.done'));
      fs.writeFileSync(lock,String(process.pid));
      console.log('ready');
      setTimeout(()=>{fs.writeFileSync(path.join(dir,first?'original.done':'replacement.done'),String(Date.now()));fs.unlinkSync(lock);process.exit(0);},first?2500:20);
    `);
    child = spawn(process.execPath, [agent, config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/run-remote-print-agent.ps1'), '-ConfigFile', config, '-NodeExe', process.execPath], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(fs.readFileSync(path.join(directory, 'supervisor.log'), 'utf8'), /supervising existing receiver/);
    assert.ok(Number(fs.readFileSync(path.join(directory, 'replacement.done'))) >= Number(fs.readFileSync(path.join(directory, 'original.done'))));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('launcher keeps recovering after repeated crashes instead of requiring a manual marker reset', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote repeated crash '));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    const config = path.join(directory, 'agent.json');
    fs.writeFileSync(config, '{}');
    // The same crash repeats four times, which previously exhausted the
    // restart budget and left the receiver stopped until an operator acted.
    fs.writeFileSync(path.join(directory, 'scripts/remote-print-agent.cjs'), 'process.exit(7);');
    const restarts = Array.from({ length: 4 }, () => ({
      at: Date.now() - 60000, pid: 1234, ageSeconds: 91
    }));
    fs.writeFileSync(path.join(directory, 'receiver-restarts.json'), JSON.stringify(restarts));
    fs.writeFileSync(path.join(directory, 'receiver-needs-attention.txt'), 'stale from an older release');
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/run-remote-print-agent.ps1'), '-ConfigFile', config, '-NodeExe', process.execPath], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    for (let index = 0; index < 2; index++) {
      const result = run();
      assert.equal(result.status, 7, result.stderr || result.error?.message);
    }
    assert.equal(fs.existsSync(path.join(directory, 'receiver-needs-attention.txt')), false);
    assert.match(fs.readFileSync(path.join(directory, 'supervisor.log'), 'utf8'), /prior automatic restarts in the last 30 minutes: 4/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
