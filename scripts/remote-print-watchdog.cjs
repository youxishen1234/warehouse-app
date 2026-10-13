// Independent heartbeat watchdog for the remote print receiver.
//
// Why this is a separate process: Windows reports a hung process as "running",
// so Task Scheduler's every-minute recovery never fires for a receiver that has
// stopped working. Only its heartbeat proves that, and the launcher is blocked
// waiting for the receiver to exit.
//
// The receiver writes two timestamps: `at` from a timer (the event loop turns)
// and `progress` after every main-loop round (work is not stuck). Every awaited
// step in that loop has its own timeout, so a long native print still finishes
// a round well inside the progress limit.
//
// This process never prints and never touches the job journal. It only ends the
// exact receiver it was given, together with its print child, and records why.
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const [receiverArg, heartbeatFile, stallFile, loopStaleArg, progressStaleArg, pollArg] = process.argv.slice(2);
const positive = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const receiverPid = Number(receiverArg);
if (!Number.isSafeInteger(receiverPid) || receiverPid <= 0 || !heartbeatFile || !stallFile) {
  console.error('usage: remote-print-watchdog.cjs <receiverPid> <heartbeat> <stallFile> [loopStaleS] [progressStaleS] [pollMs]');
  process.exit(2);
}
const loopStaleMs = positive(loopStaleArg, 90) * 1000;
const progressStaleMs = positive(progressStaleArg, 300) * 1000;
const pollMs = positive(pollArg, 5000);
const startedAt = Date.now();

// Signal 0 tests for existence without delivering anything. EPERM still means
// the process exists.
const alive = () => {
  try { process.kill(receiverPid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const endReceiver = () => {
  try {
    // The receiver may be inside a native print; its Electron child must go too.
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(receiverPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    else process.kill(receiverPid, 'SIGKILL');
  } catch { /* already gone */ }
};

// A beat left behind by an earlier receiver must never count for this one, and
// a beat read mid-rename falls back to the last good one.
let lastBeat = null;
const readBeat = () => {
  try {
    const beat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
    if (beat && beat.pid === receiverPid && Number.isFinite(beat.at) && Number.isFinite(beat.progress)) lastBeat = beat;
  } catch { /* keep lastBeat */ }
  return lastBeat;
};

const tick = () => {
  if (!alive()) process.exit(0); // the receiver ended on its own
  const now = Date.now(), beat = readBeat();
  // Before the first beat, both clocks run from when the watchdog started.
  const loopAge = now - (beat ? beat.at : startedAt);
  const progressAge = now - (beat ? beat.progress : startedAt);
  const reason = loopAge > loopStaleMs ? 'loop' : progressAge > progressStaleMs ? 'progress' : '';
  if (!reason) return;
  // Write the marker BEFORE ending the receiver: the launcher only looks after
  // the receiver exits, so the marker is already on disk by then.
  const record = { pid: receiverPid, reason, ageSeconds: Math.round((reason === 'loop' ? loopAge : progressAge) / 100) / 10, at: now };
  try {
    fs.writeFileSync(stallFile + '.tmp', JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(stallFile + '.tmp', stallFile);
  } catch { /* the launcher then reports a plain exit, which is still recovered */ }
  endReceiver();
  process.exit(10);
};

// This timer is the only thing keeping the watchdog alive; it must not be unref'd.
setInterval(tick, pollMs);
tick();
