const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const speech = require('./ai-speech');

const wave = Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(128)]);
const audio = `data:audio/wav;base64,${wave.toString('base64')}`;
const image = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;

test('voice validation rejects paths, disguised files, noncanonical base64 and oversized audio', () => {
  assert.equal(speech.validateAudio(audio).format, 'wav');
  for (const input of [undefined, '', '/etc/passwd', 'https://example.test/a.wav', audio.replace('audio/wav', 'audio/mp4'), `data:audio/wav;base64,${Buffer.alloc(80).toString('base64')}`, audio + '\n', 'data:audio/wav;base64,' + 'A'.repeat(8 * 1024 * 1024 + 4)]) {
    assert.throws(() => speech.validateAudio(input), error => error.status === 400);
  }
});

test('voice subprocess bounds execution, sanitizes errors and prevents overlapping recognition', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-speech-'));
  for (const name of ['python', 'model_quant.onnx', 'chn_jpn_yue_eng_ko_spectok.bpe.model', 'am.mvn', 'config.yaml']) fs.writeFileSync(path.join(dir, name), 'test');
  const env = { WAREHOUSE_AI_SPEECH_DIR: dir, WAREHOUSE_AI_SPEECH_PYTHON: path.join(dir, 'python') };
  let child;
  const spawnImpl = (program, args, options) => {
    assert.equal(program, env.WAREHOUSE_AI_SPEECH_PYTHON);
    assert.equal(args.at(-1), 'wav');
    assert.equal(options.windowsHide, true);
    child = new EventEmitter();
    for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
    child.kill = () => { child.killed = true; };
    return child;
  };
  try {
    const first = speech.transcribe(speech.validateAudio(audio), { env, spawnImpl });
    await assert.rejects(speech.transcribe(speech.validateAudio(audio), { env, spawnImpl }), error => error.status === 429);
    const bytes = Buffer.from(JSON.stringify({ text: '查询库存', seconds: 2 }));
    child.stdout.write(bytes.subarray(0, 10)); child.stdout.write(bytes.subarray(10)); child.emit('close', 0);
    assert.deepEqual(await first, { text: '查询库存', seconds: 2 });
    const timed = speech.transcribe(speech.validateAudio(audio), { env, spawnImpl, timeoutMs: 10 });
    await assert.rejects(timed, error => error.status === 504);
    assert.equal(child.killed, true);
    const bad = speech.transcribe(speech.validateAudio(audio), { env, spawnImpl });
    child.stdout.write('secret decoder log'); child.emit('close', 1);
    await assert.rejects(bad, error => error.status === 502 && !error.message.includes('secret'));
    const long = speech.transcribe(speech.validateAudio(audio), { env, spawnImpl });
    child.stdout.write('{"error":"TOO_LONG"}'); child.emit('close', 1);
    await assert.rejects(long, /最多 60 秒/);
    const controller = new AbortController();
    const cancelled = speech.transcribe(speech.validateAudio(audio), { env, spawnImpl, signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, error => error.status === 499);
    assert.equal(child.killed, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('photo and voice APIs use shared model validation and prepare drafts without warehouse writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-media-'));
  const app = express(); app.use(express.json({ limit: '17mb' }));
  const product = { id: 1, name: '测试纸箱', unit: '张', stock: 8, price: 2 };
  const db = { revision: () => 7, listProducts: () => [product], listCustomers: () => [], listSuppliers: () => [], stockIn: () => assert.fail('Recognition must not commit stock') };
  let decoded = 0, calls = [];
  const env = { WAREHOUSE_AI_CONFIG_FILE: path.join(dir, 'settings.json'), WAREHOUSE_AI_BASE_URL: 'https://model.example.test/v1', WAREHOUSE_AI_API_KEY: 'server-only-secret', WAREHOUSE_AI_MODEL: 'deepseek-v4-flash', WAREHOUSE_AI_RATE_LIMIT: '4' };
  require('./ai').install(app, db, {
    env, speechStatusImpl: () => ({ available: true, maxSeconds: 60, maxBytes: speech.MAX_BYTES }),
    transcribeImpl: async value => { decoded++; assert.equal(value.format, 'wav'); return { text: '商品1入库2张', seconds: 2 }; },
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'prepare_warehouse_action', arguments: JSON.stringify({ action: 'stock_in', product_id: 1, quantity: 2, unit: '张' }) } }] } }] });
    }
  });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const call = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await call('/ai/status')).body.data.voice.available, true);
    assert.equal((await call('/ai/photo', { images: [] })).status, 400);
    assert.equal((await call('/ai/voice', { audio: 'https://evil.test/a.wav' })).status, 400);
    assert.equal((await call('/ai/voice', { audio, apiKey: 'client-key' })).status, 400);
    assert.equal(decoded, 0); assert.equal(calls.length, 0);
    const photo = await call('/ai/photo', { images: [image] });
    assert.equal(photo.status, 200); assert.equal(photo.body.data.status, 'ready');
    assert.equal(photo.body.data.input_type, 'photo');
    assert.equal(calls[0].messages[1].content[1].image_url.url, image);
    assert.equal(JSON.parse(calls[0].messages[1].content[0].text).message, '请识别入库单，整理入库明细');
    const voice = await call('/ai/voice', { audio });
    assert.equal(voice.body.data.transcript, '商品1入库2张');
    assert.equal(voice.body.data.input_type, 'voice');
    assert.equal(voice.body.data.preview.stock_after, 10);
    assert.equal(product.stock, 8);
    const combined = await call('/ai/voice', { audio, images: [image], message: '按这张单子', context: { action: 'stock_in' } });
    assert.equal(combined.status, 200);
    const input = JSON.parse(calls[2].messages[1].content[0].text);
    assert.equal(input.message, '商品1入库2张\n补充说明：按这张单子');
    assert.deepEqual(input.context, { action: 'stock_in' });
    await call('/ai/command', { message: '入库' });
    const limited = await call('/ai/photo', { images: [image] });
    assert.equal(limited.status, 429, 'Media and text share the model request budget');
    assert.equal(calls.length, 4);
    assert.doesNotMatch(JSON.stringify([photo, voice, combined, limited]), /server-only-secret/);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
