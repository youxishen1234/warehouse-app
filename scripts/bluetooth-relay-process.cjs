const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_HELPER = path.join(__dirname, 'bluetooth-630k-relay.exe');

function createBleHelperManager({
  endpoint,
  capability,
  name = 'Warehouse-630K-Relay',
  executable = process.env.WAREHOUSE_BLE_HELPER || DEFAULT_HELPER,
  report = () => {},
  restartDelayMs = 5000,
}) {
  let child;
  let stopped = false;
  let nextStartAt = 0;
  let missingReported = false;

  const ensure = () => {
    if (stopped || child || Date.now() < nextStartAt) return false;
    if (!fs.existsSync(executable)) {
      if (!missingReported) {
        missingReported = true;
        report(new Error('蓝牙中继程序尚未安装，网络打印保持可用；请运行 install-bluetooth-630k.ps1'));
      }
      nextStartAt = Date.now() + 60000;
      return false;
    }
    missingReported = false;
    const env = {
      ...process.env,
      WAREHOUSE_BLE_API: endpoint,
      WAREHOUSE_BLE_TOKEN: capability,
      WAREHOUSE_BLE_NAME: name,
      WAREHOUSE_BLE_PARENT_PID: String(process.pid),
    };
    child = spawn(executable, [], {
      cwd: path.dirname(executable),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => {
      for (const line of String(value).split(/\r?\n/)) if (line.trim()) report(new Error('蓝牙中继：' + line.trim()));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', value => {
      for (const line of String(value).split(/\r?\n/)) if (line.trim()) report(new Error('蓝牙中继：' + line.trim()));
    });
    child.once('error', error => {
      if (!stopped) report(new Error('蓝牙中继无法启动：' + error.message));
    });
    child.once('close', (code, signal) => {
      child = undefined;
      if (stopped) return;
      report(new Error(`蓝牙中继已退出（${signal || code || 'unknown'}），稍后自动恢复`));
      nextStartAt = Date.now() + restartDelayMs;
    });
    return true;
  };

  return {
    start: ensure,
    ensure,
    running: () => !!child,
    stop() {
      stopped = true;
      if (!child) return;
      try { child.kill(); } catch {}
      child = undefined;
    },
  };
}

module.exports = { createBleHelperManager, DEFAULT_HELPER };
