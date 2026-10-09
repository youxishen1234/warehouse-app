const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { createSettings } = require('./ai-settings');
const { interpret } = require('./ai-provider');

test('model configuration validates credentials before saving, protects secrets and survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-'));
  const env = { WAREHOUSE_AI_CONFIG_FILE: path.join(dir, 'connection.json') };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'test', role: req.get('X-Test-Role') || 'operator' }; next(); });
  let responseStatus = 200, modelRequests = 0;
  const fetchImpl = async (url, options) => {
    modelRequests++;
    assert.equal(url, 'https://ai.example.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer private-model-key');
    assert.doesNotMatch(options.body, /private-model-key/);
    if (responseStatus !== 200) return new Response('private-model-key upstream details', { status: responseStatus });
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'prepare_query', arguments: JSON.stringify({ resource: 'products' }) } }] } }] });
  };
  require('./ai').install(app, { revision: () => 7 }, { env, fetchImpl });
  app.use((error, req, res, next) => res.status(error.status || 500).json({success: false, message: error.message}));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const call = async (route, method = 'GET', body, role = 'admin') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Test-Role': role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const config = { baseUrl: 'https://ai.example.test/v1/chat/completions/', model: 'vision-model', apiKey: 'private-model-key' };
  try {
    for (const role of ['operator', 'viewer', '']) {
      // 免登录共享模式：配置可读（不泄露密钥），写操作仍受保护。
      assert.equal((await call('/ai/config', 'GET', undefined, role)).status, 200);
      assert.equal((await call('/ai/config', 'PUT', config, role)).status, 403);
      assert.equal((await call('/ai/config/test', 'POST', config, role)).status, 403);
    }
    assert.equal(modelRequests, 0);
    const initial = await call('/ai/status', 'GET', undefined, 'operator');
    assert.equal(initial.body.data.mode, 'rules');
    assert.equal(initial.body.data.canConfigure, false);
    assert.equal((await call('/ai/config/test', 'POST', config)).status, 200);
    assert.equal(fs.existsSync(env.WAREHOUSE_AI_CONFIG_FILE), false, 'testing never saves');
    const saved = await call('/ai/config', 'PUT', config);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.hasKey, true);
    assert.doesNotMatch(JSON.stringify(saved.body), /private-model-key|apiKey/);
    const bytes = fs.readFileSync(env.WAREHOUSE_AI_CONFIG_FILE, 'utf8');
    const restarted = createSettings(env);
    assert.equal(restarted.current().WAREHOUSE_AI_API_KEY, 'private-model-key');
    assert.equal((await call('/ai/status')).body.data.mode, 'model');
    const read = await call('/ai/config');
    assert.doesNotMatch(JSON.stringify(read.body), /private-model-key|apiKey/);
    assert.equal(restarted.candidate({ ...config, apiKey: '' }).WAREHOUSE_AI_API_KEY, 'private-model-key');
    assert.throws(() => restarted.candidate({ ...config, baseUrl: 'https://other.example.test/v1', apiKey: '' }), /重新填写密钥/);
    responseStatus = 401;
    const failed = await call('/ai/config', 'PUT', config);
    assert.equal(failed.status, 502);
    assert.match(failed.body.message, /密钥无效/);
    assert.doesNotMatch(JSON.stringify(failed.body), /private-model-key|upstream/);
    assert.equal(fs.readFileSync(env.WAREHOUSE_AI_CONFIG_FILE, 'utf8'), bytes, 'failed configuration cannot replace a working one');
    if (process.platform !== 'win32') assert.equal(fs.statSync(env.WAREHOUSE_AI_CONFIG_FILE).mode & 0o777, 0o600);
  } finally { await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('pasting the full completion URL never duplicates its path', async () => {
  let requested;
  await interpret('入库', undefined, { env: { WAREHOUSE_AI_BASE_URL: 'https://ai.example.test/v1/chat/completions/', WAREHOUSE_AI_API_KEY: 'test-key', WAREHOUSE_AI_MODEL: 'test' }, fetchImpl: async url => {
    requested = url;
    return Response.json({ choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{type: 'function', function: {name: 'prepare_warehouse_action', arguments: '{"action":"stock_in"}'}}]}}] });
  } });
  assert.equal(requested, 'https://ai.example.test/v1/chat/completions');
});


test('anonymous devices can configure AI with the server admin key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-settings-key-'));
  const env = { WAREHOUSE_AI_CONFIG_FILE: path.join(dir, 'connection.json'), WAREHOUSE_ADMIN_KEY: 'secret-admin-key' };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'guest-device', role: req.get('X-Test-Role') || '' }; next(); });
  const fetchImpl = async () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'prepare_query', arguments: JSON.stringify({ resource: 'products' }) } }] } }] });
  require('./ai').install(app, { revision: () => 7 }, { env, fetchImpl });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, method = 'GET', body, extra = {}) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const config = { baseUrl: 'https://ai.example.test/v1/chat/completions/', model: 'vision-model', apiKey: 'private-model-key' };
  try {
    assert.equal((await call('/ai/config')).status, 200, '配置对匿名设备可读');
    assert.equal((await call('/ai/config', 'PUT', config)).status, 403, '缺少管理密钥拒绝写入');
    assert.equal((await call('/ai/config', 'PUT', config, { 'X-Warehouse-Admin-Key': 'wrong-key' })).status, 403, '错误密钥拒绝写入');
    assert.equal((await call('/ai/config/test', 'POST', config, { 'X-Warehouse-Admin-Key': 'secret-admin-key' })).status, 200, '正确密钥可测试连接');
    assert.equal((await call('/ai/config', 'PUT', config, { 'X-Warehouse-Admin-Key': 'secret-admin-key' })).status, 200, '正确密钥可保存配置');
    const status = await call('/ai/status');
    assert.equal(status.body.data.canConfigure, true);
  } finally { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
