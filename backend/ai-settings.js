const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fail = message => Object.assign(new Error(message), { status: 400 });
function createSettings(env = process.env) {
  const file = env.WAREHOUSE_AI_CONFIG_FILE || path.join(__dirname, 'runtime', 'ai-connection.json');
  const current = () => {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw fail('服务端模型配置文件无法读取，请联系管理员'); }
    return saved ? { ...env, WAREHOUSE_AI_BASE_URL: saved.baseUrl, WAREHOUSE_AI_MODEL: saved.model, WAREHOUSE_AI_API_KEY: saved.apiKey, WAREHOUSE_AI_REASONING_EFFORT: saved.reasoningEffort || '' } : { ...env };
  };
  const publicConfig = () => {
    const config = current();
    return { baseUrl: config.WAREHOUSE_AI_BASE_URL || '', model: config.WAREHOUSE_AI_MODEL || '', hasKey: !!config.WAREHOUSE_AI_API_KEY, reasoningEffort: config.WAREHOUSE_AI_REASONING_EFFORT || '' };
  };
  const candidate = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['baseUrl', 'model', 'apiKey', 'reasoningEffort'].includes(key))) throw fail('模型设置参数无效');
    const text = (key, max) => {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > max || /[\r\n\u0000]/.test(body[key]))) throw fail('模型设置字段格式无效');
      return (body[key] || '').trim();
    };
    const baseUrl = text('baseUrl', 2048).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const model = text('model', 200);
    const reasoningEffort = text('reasoningEffort', 20);
    const old = current();
    const previousBase = (old.WAREHOUSE_AI_BASE_URL || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const apiKey = text('apiKey', 4096) || (baseUrl === previousBase ? old.WAREHOUSE_AI_API_KEY : '');
    if (!baseUrl || !model || !apiKey) throw fail('请填写服务地址、模型名称和 API Key；更换地址后需要重新填写密钥');
    return { ...env, WAREHOUSE_AI_BASE_URL: baseUrl, WAREHOUSE_AI_MODEL: model, WAREHOUSE_AI_API_KEY: apiKey, WAREHOUSE_AI_REASONING_EFFORT: reasoningEffort };
  };
  const save = config => {
    const data = { baseUrl: config.WAREHOUSE_AI_BASE_URL, model: config.WAREHOUSE_AI_MODEL, apiKey: config.WAREHOUSE_AI_API_KEY, reasoningEffort: config.WAREHOUSE_AI_REASONING_EFFORT || '' };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    catch (error) { try { fs.unlinkSync(temp); } catch {} throw Object.assign(new Error('模型设置保存失败，请检查服务器配置目录权限'), { status: 500 }); }
    return publicConfig();
  };
  return { current, publicConfig, candidate, save };
}
module.exports = { createSettings };
