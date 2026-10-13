const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const watchdogScript = path.resolve('scripts/remote-print-watchdog.cjs');
const exited = child => child.exitCode !== null || child.signalCode !== null;
const writeBeat = (file, beat) => fs.writeFileSync(file, JSON.stringify(beat));

async function withFixture(name, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const children = [];
  const start = (args, options) => { const child = spawn(process.execPath, args, { windowsHide: true, stdio: 'ignore', ...options }); children.push(child); return child; };
  try { await run({ directory, start }); } finally {
    for (const child of children) if (!exited(child)) { const exit = once(child, 'exit'); child.kill(); await exit; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const watch = (start, pid, directory, loop, progress) => start([watchdogScript, String(pid), path.join(directory, 'beat.json'), path.join(directory, 'stall.json'), String(loop), String(progress), '100']);

test('watchdog keeps waiting while the receiver beats, and exits quietly when it ends', async () => {
  await withFixture('watchdog healthy ', async ({ directory, start }) => {
    const receiver = start(['-e', 'setTimeout(()=>{},60000)']);
    const beat = path.join(directory, 'beat.json');
    const timer = setInterval(() => writeBeat(beat, { pid: receiver.pid, at: Date.now(), progress: Date.now() }), 100);
    writeBeat(beat, { pid: receiver.pid, at: Date.now(), progress: Date.now() });
    try {
      const dog = watch(start, receiver.pid, directory, 1, 1);
      // Well past both limits: only fresh beats keep the receiver alive.
      await new Promise(resolve => setTimeout(resolve, 2500));
      assert.ok(!exited(dog), 'watchdog must keep polling, not exit after the first check');
      assert.ok(!exited(receiver), 'a beating receiver must never be ended');
      const dogExit = once(dog, 'exit');
      receiver.kill();
      const [code] = await dogExit;
      assert.equal(code, 0);
      assert.equal(fs.existsSync(path.join(directory, 'stall.json')), false);
    } finally { clearInterval(timer); }
  });
});

test('watchdog ends a receiver whose event loop stopped and records why', async () => {
  await withFixture('watchdog loop ', async ({ directory, start }) => {
    const receiver = start(['-e', 'setTimeout(()=>{},60000)']);
    writeBeat(path.join(directory, 'beat.json'), { pid: receiver.pid, at: Date.now(), progress: Date.now() });
    const receiverExit = once(receiver, 'exit');
    const [code] = await once(watch(start, receiver.pid, directory, 1, 60), 'exit');
    assert.equal(code, 10);
    await receiverExit;
    const stall = JSON.parse(fs.readFileSync(path.join(directory, 'stall.json'), 'utf8'));
    assert.equal(stall.pid, receiver.pid);
    assert.equal(stall.reason, 'loop');
  });
});

test('watchdog ends a receiver whose loop turns but whose work is stuck', async () => {
  await withFixture('watchdog progress ', async ({ directory, start }) => {
    const receiver = start(['-e', 'setTimeout(()=>{},60000)']);
    const beat = path.join(directory, 'beat.json'), stuckAt = Date.now();
    const timer = setInterval(() => writeBeat(beat, { pid: receiver.pid, at: Date.now(), progress: stuckAt }), 100);
    writeBeat(beat, { pid: receiver.pid, at: Date.now(), progress: stuckAt });
    try {
      const [code] = await once(watch(start, receiver.pid, directory, 60, 1), 'exit');
      assert.equal(code, 10);
      assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'stall.json'), 'utf8')).reason, 'progress');
    } finally { clearInterval(timer); }
  });
});

test('watchdog ignores a heartbeat left by a different receiver', async () => {
  await withFixture('watchdog foreign ', async ({ directory, start }) => {
    const receiver = start(['-e', 'setTimeout(()=>{},60000)']);
    const beat = path.join(directory, 'beat.json');
    // A fresh beat for another PID must not vouch for this receiver.
    const timer = setInterval(() => writeBeat(beat, { pid: receiver.pid + 1, at: Date.now(), progress: Date.now() }), 100);
    try {
      const [code] = await once(watch(start, receiver.pid, directory, 1, 60), 'exit');
      assert.equal(code, 10);
    } finally { clearInterval(timer); }
  });
});

test('watchdog rejects a missing receiver PID', () => {
  const result = spawnSync(process.execPath, [watchdogScript], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
});

test('launcher ends a hung receiver through the watchdog and reports a stall', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote hung receiver '));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    const config = path.join(directory, 'agent.json');
    fs.writeFileSync(config, '{}');
    fs.copyFileSync(watchdogScript, path.join(directory, 'scripts/remote-print-watchdog.cjs'));
    // Beats once, then blocks its event loop forever: alive to Windows, dead in practice.
    fs.writeFileSync(path.join(directory, 'scripts/remote-print-agent.cjs'), `
      const fs=require('node:fs'),path=require('node:path');
      const beat=path.join(path.dirname(process.argv[2]),'receiver-heartbeat.json');
      fs.writeFileSync(beat,JSON.stringify({pid:process.pid,at:Date.now(),progress:Date.now()}));
      console.log('hung fixture started');
      for(;;){}
    `);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/run-remote-print-agent.ps1'), '-ConfigFile', config, '-NodeExe', process.execPath, '-LoopStaleSeconds', '5', '-ProgressStaleSeconds', '60'], { windowsHide: true, encoding: 'utf8', timeout: 45000 });
    assert.equal(result.status, 3, result.stderr || result.error?.message);
    const lifecycle = fs.readFileSync(path.join(directory, 'supervisor.log'), 'utf8');
    assert.match(lifecycle, /heartbeat stalled \(loop, /);
    assert.match(lifecycle, /restart 1 of 3/);
    assert.equal(fs.existsSync(path.join(directory, 'receiver-stall.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'receiver-restarts.json'), 'utf8').replace(/^﻿/, '')).length, 1);
    assert.equal(fs.readFileSync(config, 'utf8'), '{}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
