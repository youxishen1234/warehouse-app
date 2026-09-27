const { Client } = require('ssh2');
const host = '152.136.100.200';
const users = ['root', 'ubuntu', 'lighthouse'];
const passwords = ['shuguang2026'];
let done = false;
function tryOne(u, p) {
  return new Promise(resolve => {
    const conn = new Client();
    let result = null;
    conn.on('ready', () => {
      conn.exec('whoami; ls /opt/shuguang/public 2>/dev/null', (e, s) => {
        if (e) { conn.end(); return resolve(null); }
        let out = '';
        s.on('data', d => out += d);
        s.stderr.on('data', d => out += d);
        s.on('close', () => { result = out; conn.end(); });
      });
    });
    conn.on('error', () => {});
    conn.on('close', () => resolve(result));
    conn.connect({ host, username: u, password: p, readyTimeout: 10000 });
  });
}
(async () => {
  for (const u of users) {
    for (const p of passwords) {
      const r = await tryOne(u, p);
      if (r) { console.log(`SUCCESS ${u}/${p}`); console.log(r); done = true; break; }
      else console.log(`fail ${u}/${p}`);
    }
    if (done) break;
  }
})();
