const { test } = require('node:test');
const assert = require('node:assert/strict');
const { interpret, INTENT_TOOL } = require('./ai-provider');
const aiTools = require('./ai-tools');

const env = { WAREHOUSE_AI_BASE_URL: 'https://ai.example.test/v1', WAREHOUSE_AI_API_KEY: 'private-provider-key', WAREHOUSE_AI_MODEL: 'configured-model' };
const completion = args => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: INTENT_TOOL.function.name, arguments: JSON.stringify(args) } }] } }] });
const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('model adapter passes bounded instructions and schema, never gives the model a database executor', async () => {
  let request;
  const result = await interpret('帮我给测试客户出库五张纸箱', undefined, { env, fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return jsonResponse(completion({ action: 'stock_out', product_name: '纸箱', customer_name: '测试客户', quantity: 5, unit: '张' }));
  } });
  assert.equal(request.url, 'https://ai.example.test/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer private-provider-key');
  assert.equal(request.redirect, 'error');
  assert.equal(request.body.model, 'configured-model');
  assert.equal(request.body.stream, false);
  assert.ok(request.body.tools.length >= 25);
  assert.equal(request.body.tools[0].function.name, 'prepare_warehouse_action');
  assert.equal(result.provider, 'model');
  assert.equal(result.intent.quantity, 5);
  assert.doesNotMatch(JSON.stringify(request.body), /private-provider-key/);
});

test('vision model receives photos and can extract a multi-line delivery receipt tool call', async () => {
  let request;
  const image = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 217]).toString('base64')}`;
  const result = await interpret('识别这张送货单', undefined, { env, images: [image], fetchImpl: async (url, options) => {
    request = JSON.parse(options.body);
    return jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{
      type: 'function', function: { name: 'prepare_receipt_in', arguments: JSON.stringify({
        supplier_name: '测试供应商', date: '2026-09-30', work_order_no: 'DN-1', lines: [
          { product_name: '纸箱 A', quantity: 20, delivered_qty: 19, unit_price: 2.5 },
          { product_name: '胶带', quantity: 2, delivered_qty: 2, unit_price: 3 }
        ]
      }) }
    }] } }] });
  } });
  assert.equal(result.provider, 'model');
  assert.equal(result.intent.action, 'receipt_in');
  assert.equal(result.intent.parameters.lines.length, 2);
  assert.equal(result.intent.parameters.lines[0].delivered_qty, 19);
  assert.equal(request.messages[1].content[1].image_url.url, image);
  assert.ok(request.tools.some(tool => tool.function.name === 'prepare_receipt_in'));
});

test('catalogue validation preserves boolean values for the editable assistant form', () => {
  const schema = { type: 'object', properties: { enabled: { type: 'boolean', title: '启用' } }, required: ['enabled'] };
  assert.deepEqual(aiTools.validate({ enabled: false }, schema), { enabled: false });
  assert.throws(() => aiTools.validate({ enabled: 'false' }, schema), /必须为是或否/);
});

test('photo schema mismatch is reinterpreted once without dropping receipt lines or coercing the action', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const lines = [{ product_name: 'VISION-8426', quantity: 9, delivered_qty: 7, unit_price: 1.35 },
    { product_name: 'PANEL-5931', quantity: 13, delivered_qty: 13, unit_price: 2.7 }];
  const requests = [];
  const result = await interpret('识别入库单', undefined, { env, images: [image], fetchImpl: async (url, options) => {
    requests.push({ body: JSON.parse(options.body), signal: options.signal });
    if (requests.length === 1) return jsonResponse(completion({ action: 'stock_in', date: '2026-10-03', lines }));
    return jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function',
      function: { name: 'prepare_receipt_in', arguments: JSON.stringify({ date: '2026-10-03', lines }) } }] } }] });
  } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.deepEqual(requests[0].body.messages[1], requests[1].body.messages[1]);
  assert.match(requests[1].body.messages[0].content, /上一次返回的工具参数未通过 schema 校验/);
  assert.equal(result.intent.action, 'receipt_in');
  assert.deepEqual(result.intent.parameters.lines, lines);
});

test('invalid photo output stops after one repair attempt and keeps its original deadline', async () => {
  const options = { env, images: ['data:image/png;base64,iVBORw0KGgo='] };
  let calls = 0;
  await assert.rejects(interpret('识别入库单', undefined, { ...options, fetchImpl: async () => {
    calls += 1;
    return jsonResponse(completion({ action: 'stock_in', private_provider_key: 'private-provider-key' }));
  } }), error => error.status === 502 && !error.message.includes('private-provider-key'));
  assert.equal(calls, 2);
  calls = 0;
  let signal;
  await assert.rejects(interpret('识别入库单', undefined, { ...options, timeoutMs: 25, fetchImpl: async (url, request) => {
    calls += 1;
    if (calls === 1) {
      signal = request.signal;
      return jsonResponse(completion({ action: 'stock_in', lines: [] }));
    }
    assert.equal(request.signal, signal);
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }), error => error.status === 504);
  assert.equal(calls, 2);
});

test('optional reasoning setting is forwarded only when explicitly configured', async () => {
  await interpret('入库', undefined, { env: { ...env, WAREHOUSE_AI_REASONING_EFFORT: 'none' }, fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).reasoning_effort, 'none');
    return jsonResponse(completion({ action: 'stock_in' }));
  } });
});

test('model can ask for missing fields and receives only the supplied context', async () => {
  const context = { action: 'stock_in', product_id: 5 };
  const result = await interpret('数量二十', context, { env, fetchImpl: async (url, options) => {
    const messages = JSON.parse(options.body).messages;
    assert.deepEqual(JSON.parse(messages[1].content), { message: '数量二十', context });
    return jsonResponse(completion({ action: 'stock_in', product_id: 5, quantity: 20 }));
  } });
  assert.equal(result.intent.quantity, 20);
  const missing = await interpret('入库', undefined, { env, fetchImpl: async () => jsonResponse(completion({ action: 'stock_in' })) });
  assert.deepEqual(missing.intent, { action: 'stock_in' });
});

test('malformed, unsupported, multi-action and truncated provider output is rejected', async () => {
  const multiple = completion({ action: 'stock_in' });
  multiple.choices[0].message.tool_calls.push(multiple.choices[0].message.tool_calls[0]);
  const truncated = completion({ action: 'stock_in' }); truncated.choices[0].finish_reason = 'length';
  const wrongTool = completion({ action: 'stock_in' }); wrongTool.choices[0].message.tool_calls[0].function.name = 'delete_database';
  for (const data of [
    {}, multiple, truncated, wrongTool, completion({ action: 'delete' }),
    completion({ action: 'stock_out', quantity: -5 }), completion({ action: 'stock_in', product_id: '1' }),
    completion({ action: 'stock_in', customer_id: 1 }), completion({ action: 'print', latest: true, transaction_id: 1 }),
    completion({ action: 'stock_in', url: 'https://evil.test' }),
    completion(JSON.parse('{"action":"stock_in","__proto__":{"product_id":1,"quantity":1}}'))
  ]) {
    await assert.rejects(interpret('入库', undefined, { env, fetchImpl: async () => jsonResponse(data) }), error => error.status === 502);
  }
  await assert.rejects(interpret('入库', undefined, { env, fetchImpl: async () => new Response('not-json private-provider-key') }), error => error.status === 502 && !error.message.includes('private-provider-key'));
});

test('provider failures are sanitized and never fall back to an executable rule', async () => {
  for (const status of [401, 429, 500]) {
    await assert.rejects(interpret('商品1入库20张', undefined, { env, fetchImpl: async () => new Response('private-provider-key', { status }) }), error => error.status === 502 && !error.message.includes('private-provider-key'));
  }
  await assert.rejects(interpret('入库', undefined, { env, fetchImpl: async () => { throw new Error('private-provider-key https://secret'); } }), error => error.status === 502 && !/private-provider-key|secret/.test(error.message));
  await assert.rejects(interpret('入库', undefined, { env, fetchImpl: async () => { throw Object.assign(new Error('private-provider-key'), { status: 500 }); } }), error => error.status === 502 && !error.message.includes('private-provider-key'));
  await assert.rejects(interpret('入库', undefined, { env, fetchImpl: async () => new Response('x'.repeat(128 * 1024 + 1)) }), error => error.status === 502);
});

test('upstream timeout covers both the initial request and body consumption', async () => {
  const waitForAbort = signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  await assert.rejects(interpret('入库', undefined, { env, timeoutMs: 15, fetchImpl: (url, options) => waitForAbort(options.signal) }), error => error.status === 504);
  await assert.rejects(interpret('入库', undefined, { env, timeoutMs: 15, fetchImpl: async (url, options) => ({ ok: true, body: { getReader: () => ({ read: () => waitForAbort(options.signal), releaseLock() {} }) } }) }), error => error.status === 504);
});

test('configuration requires a complete server-side setup with an HTTPS or loopback endpoint', async () => {
  for (const config of [
    { WAREHOUSE_AI_API_KEY: 'private-provider-key' },
    { ...env, WAREHOUSE_AI_BASE_URL: 'file:///secret' },
    { ...env, WAREHOUSE_AI_BASE_URL: 'https://user:pass@ai.example.test/v1' },
    { ...env, WAREHOUSE_AI_BASE_URL: 'https://ai.example.test/v1?key=secret' },
    { ...env, WAREHOUSE_AI_BASE_URL: 'http://remote.example.test/v1' }
  ]) await assert.rejects(interpret('入库', undefined, { env: config, fetchImpl: () => { throw new Error('must not fetch'); } }), error => error.status === 503);
  const rules = await interpret('商品1入库20张', undefined, { env: {}, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal(rules.provider, 'rules');
  const local = await interpret('入库', undefined, { env: { ...env, WAREHOUSE_AI_BASE_URL: 'http://127.0.0.1:1234/v1/' }, fetchImpl: async () => jsonResponse(completion({ action: 'stock_in' })) });
  assert.equal(local.provider, 'model');
});
