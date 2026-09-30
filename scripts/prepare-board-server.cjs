// Extend the existing production backend without replacing its auth/account system.
// Usage: node scripts/prepare-board-server.cjs <downloaded-server-dir> <staging-dir>
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Provide baseline and staging directories');
const root = path.resolve(__dirname, '..');
let db = fs.readFileSync(path.join(source, 'db.js'), 'utf8');
let team = fs.readFileSync(path.join(source, 'team.js'), 'utf8');
if (db.includes('function listBoards(') || team.includes("'/boards'")) throw new Error('Paperboard integration already exists; inspect the deployed version before replacing it');
for (const marker of ['let cache = load();', 'function persist()', 'function transact(', 'module.exports = {']) if (!db.includes(marker)) throw new Error('Unrecognized database: ' + marker);
const methods = [
  'function listBoards() { return require("./boards").list(cache); }',
  'function receiveBoard(raw) { const result = require("./boards").receive(cache, raw); persist(); return result; }',
  'function moveBoard(id, raw) { const result = require("./boards").move(cache, id, raw); persist(); return result; }',
].join('\n');
db = db.replace('module.exports = {', methods + '\nmodule.exports = { listBoards, receiveBoard, moveBoard,');
const current = fs.readFileSync(path.join(root, 'backend/team.js'), 'utf8');
const first = current.indexOf("  route('get', '/boards',");
const last = current.indexOf("  route('post', '/sync/upload',", first);
if (first < 0 || last < 0) throw new Error('Missing current board routes');
let routes = current.slice(first, last).replace('IDENTITY_KEY_PATTERN.test', '/^[A-Za-z0-9_-]{16,100}$/.test');
routes = routes.replace("    if (!req.is('application/json')", "    if (req.user.role === 'viewer') throw error('只读账号不能修改纸板库存', 403);\n    if (!req.is('application/json')");
const insertion = "  route('post', '/sync/upload',";
if (!team.includes(insertion)) throw new Error('Missing authenticated insertion point');
team = team.replace(insertion, routes + insertion);
new vm.Script(db); new vm.Script(team);
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'db.js'), db);
fs.writeFileSync(path.join(destination, 'team.js'), team);
fs.copyFileSync(path.join(root, 'backend/boards.js'), path.join(destination, 'boards.js'));
console.log('Staged compatible paperboard routes; existing authentication and other routes preserved.');
