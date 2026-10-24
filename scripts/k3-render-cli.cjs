#!/usr/bin/env node
// Node entry for the Electron renderer. Only trusted local code and validated
// snapshot data reach the hidden window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

// The receiver ships beside its own node_modules. Resolving from this file
// keeps deployment independent of the developer workspace path.
const localRequire = createRequire(path.join(__dirname, '..', 'package.json'));
const ELECTRON = localRequire('electron');

function renderLabel(job, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'k3-label-'));
    const inputFile = path.join(directory, 'job.json');
    const outputPng = job.outputPng || path.join(directory, 'label.png');
    fs.writeFileSync(inputFile, JSON.stringify({ ...job, outputPng }), { mode: 0o600 });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(ELECTRON, [path.join(__dirname, 'k3-render.cjs'), inputFile], {
      cwd: path.join(__dirname, '..'),
      env,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rm(directory, { recursive: true, force: true }, () => {});
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('标签渲染超时（60 秒）'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish(new Error(`无法启动渲染器：${error.message}`)));
    child.once('close', code => {
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('K3_RENDER_RESULT:'));
      if (!line) return finish(new Error(`渲染器退出（${code}）：${(stderr || stdout).trim().slice(0, 300) || '无输出'}`));
      let result;
      try { result = JSON.parse(line.slice('K3_RENDER_RESULT:'.length)); } catch { return finish(new Error('渲染器返回了无效结果')); }
      if (!result.ok) return finish(new Error(result.message || '标签渲染失败'));
      finish(null, result);
    });
  });
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('用法: node k3-render-cli.cjs <job.json>\n');
    process.exitCode = 1;
  } else {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    renderLabel(job).then(result => {
      process.stdout.write(JSON.stringify(result) + '\n');
    }).catch(error => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
  }
}

module.exports = { renderLabel };
