const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_SECONDS = 60;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, aiProviderError: true });
const formats = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'mov', 'audio/x-m4a': 'mov',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'matroska'
};
function validateAudio(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 100) throw fail('语音文件不能超过 6 MiB');
  const match = /^data:(audio\/[a-z0-9-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !formats[match[1]] || match[2].length % 4 !== 0) throw fail('请选择 WAV、MP3、M4A、AAC、OGG 或 WebM 语音文件');
  const bytes = Buffer.from(match[2], 'base64');
  const format = formats[match[1]];
  const valid = bytes.length >= 12 && (format === 'wav' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
    : format === 'mov' ? bytes.toString('ascii', 4, 8) === 'ftyp'
      : format === 'ogg' ? bytes.toString('ascii', 0, 4) === 'OggS'
        : format === 'matroska' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
          : format === 'mp3' ? bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)
            : bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0);
  if (!valid || bytes.length > MAX_BYTES || bytes.toString('base64') !== match[2]) throw fail('语音内容无效或超过 6 MiB，请重新录制');
  return { bytes, format };
}
function paths(env = process.env) {
  const directory = env.WAREHOUSE_AI_SPEECH_DIR || path.join(__dirname, 'runtime', 'speech');
  return { directory, python: env.WAREHOUSE_AI_SPEECH_PYTHON || path.join(directory, 'venv', 'bin', 'python'), worker: path.join(__dirname, 'ai-speech-worker.py') };
}
function speechStatus(env = process.env) {
  const { directory, python, worker } = paths(env);
  return { available: [python, worker, ...['model_quant.onnx', 'chn_jpn_yue_eng_ko_spectok.bpe.model', 'am.mvn', 'config.yaml'].map(name => path.join(directory, name))].every(file => fs.existsSync(file)), maxSeconds: MAX_SECONDS, maxBytes: MAX_BYTES, formats: Object.keys(formats) };
}
let running = false;
async function transcribe(audio, { env = process.env, signal, timeoutMs = 45000, spawnImpl = spawn } = {}) {
  if (!speechStatus(env).available) throw fail('服务器语音识别尚未就绪，请先使用文字或照片', 503);
  if (running) throw fail('正在识别另一条语音，请稍后重试', 429);
  if (signal?.aborted) throw fail('语音请求已取消', 499);
  const { directory, python, worker } = paths(env);
  running = true;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawnImpl(python, [worker, '--model-dir', directory, '--format', audio.format], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', OPENBLAS_NUM_THREADS: '2', OMP_NUM_THREADS: '2' }
      });
      let settled = false;
      let output = '';
      let timer;
      const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const finish = (error, result) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve(result); };
      const abort = () => { kill(); finish(fail('语音请求已取消', 499)); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { kill(); finish(fail('语音识别超时，请录短一些后重试', 504)); }, timeoutMs);
      child.on('error', () => finish(fail('服务器语音识别暂时不可用', 503)));
      child.stdin.on('error', () => {});
      child.stderr.resume(); // Decoder diagnostics may contain user content; never expose or persist them.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 16384) { kill(); finish(fail('语音识别返回内容异常', 502)); }
      });
      child.on('close', code => {
        if (settled) return;
        try {
          const result = JSON.parse(output);
          const messages = { TOO_LONG: '每条语音最多 60 秒，请分段发送', TOO_SHORT: '语音太短，请重新录制', DECODE: '无法读取这条语音，请更换文件或重新录制', NO_SPEECH: '没有听清语音，请靠近麦克风重新录制' };
          if (result.error && messages[result.error]) return finish(fail(messages[result.error]));
          if (code !== 0 || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000 || !Number.isFinite(result.seconds)) throw new Error('Invalid speech result');
          finish(null, { text: result.text.trim(), seconds: result.seconds });
        } catch { finish(fail('语音识别失败，请稍后重试', 502)); }
      });
      child.stdin.end(audio.bytes);
    });
  } finally { running = false; }
}
module.exports = { MAX_BYTES, MAX_SECONDS, validateAudio, speechStatus, transcribe };
