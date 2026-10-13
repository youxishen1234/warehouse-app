const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');

async function acquireAgentLock(configFile) {
  const file = path.join(path.dirname(configFile), 'agent.lock');
  const alreadyRunning = () => new Error('打印接收程序已经运行');
  if (process.platform === 'win32') {
    // Windows releases this pipe even after a crash. A reused PID in an old
    // lock file must not prevent the scheduler from recovering the receiver.
    const name = createHash('sha256').update(path.resolve(configFile).toLowerCase()).digest('hex');
    const server = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => {
      server.once('error', error => reject(error.code === 'EADDRINUSE' ? alreadyRunning() : error));
      server.listen('\\\\.\\pipe\\warehouse-print-' + name, resolve);
    });
    try { fs.writeFileSync(file, String(process.pid), { mode: 0o600 }); }
    catch (error) { server.close(); throw error; }
    return () => {
      if (server.listening) server.close();
      try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); } catch { /* best effort diagnostic cleanup */ }
    };
  }
  // The native receiver runs on Windows; retain the CLI lock on other hosts.
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('打印锁文件无效，请检查接收程序');
    try { process.kill(pid, 0); throw alreadyRunning(); }
    catch (issue) { if (issue.code !== 'ESRCH') throw issue; }
    fs.unlinkSync(file); fd = fs.openSync(file, 'wx', 0o600);
  }
  fs.writeFileSync(fd, String(process.pid));
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}

module.exports = { acquireAgentLock };
