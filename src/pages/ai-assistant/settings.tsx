import { useEffect, useState } from 'react';
import { aiSettingsRequest } from '@/services/ai';
import type { AiConnection } from '@/services/ai';
import { session } from '@/services/session';
import styles from './index.module.scss';

export default function AiSettings({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [token, setToken] = useState(session()?.user.role === 'admin' ? session()!.token : '');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [config, setConfig] = useState<AiConnection>({ baseUrl: '', model: '', apiKey: '' });
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!token) return;
    let alive = true;
    setReady(false); setBusy(true); setError('');
    aiSettingsRequest<AiConnection>('/ai/config', 'GET', undefined, token)
      .then(value => { if (alive) { setConfig({ ...value, apiKey: '' }); setReady(true); } })
      .catch(e => { if (alive) { setError(e.message); setToken(''); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [token]);
  const login = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const account = await aiSettingsRequest<{ token: string; user: { role: string } }>('/auth/login', 'POST', { username, password }, '');
      if (account.user.role !== 'admin') throw new Error('请使用仓库管理员账号');
      setPassword(''); setToken(account.token);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const save = async (testOnly: boolean) => {
    if (busy || !ready) return;
    setBusy(true); setError(''); setResult('');
    try {
      const value = await aiSettingsRequest<AiConnection & { message: string }>(testOnly ? '/ai/config/test' : '/ai/config', testOnly ? 'POST' : 'PUT', {
        baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey || '', reasoningEffort: config.reasoningEffort || ''
      }, token);
      setResult(testOnly ? value.message : '已保存并生效。' + value.message);
      if (!testOnly) { setConfig({ ...value, apiKey: '' }); onSaved(); }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className={styles.card} aria-label='模型接入设置'>
    <div className={styles.row}><span className={styles.sectionTitle}>重新设置 AI 模型</span><button data-ai-control="button" className={styles.textButton} disabled={busy} onClick={onClose}>收起</button></div>
    <p className={styles.hint}>填写支持工具调用的模型接口。拍单入库还需要图片识别能力；保存前会实际测试连接，失败时保留原设置。</p>
    {!token ? <form onSubmit={login}>
      <p className={styles.hint}>模型设置会对整个仓库生效，请先验证管理员身份。</p>
      <label className={styles.label}>管理员账号<input data-ai-control="input" className={styles.input} autoComplete='username' value={username} onChange={e => setUsername(e.currentTarget.value)} required disabled={busy} /></label>
      <label className={styles.label}>管理员密码<input data-ai-control="input" className={styles.input} type='password' autoComplete='current-password' value={password} onChange={e => setPassword(e.currentTarget.value)} required disabled={busy} /></label>
      <button data-ai-control="button" type='submit' className={styles.primary} disabled={busy}>{busy ? '正在验证…' : '验证管理员'}</button>
    </form> : <form onSubmit={event => { event.preventDefault(); void save(false); }}>
      <label className={styles.label}>服务地址（Base URL）<input data-ai-control="input" className={styles.input} type='url' autoComplete='off' placeholder='https://你的模型服务地址/v1' value={config.baseUrl} onChange={e => { setConfig({ ...config, baseUrl: e.currentTarget.value }); setResult(''); }} required disabled={busy || !ready} /></label>
      <label className={styles.label}>模型名称<input data-ai-control="input" className={styles.input} autoComplete='off' placeholder='填写服务商提供的准确模型名称' value={config.model} onChange={e => { setConfig({ ...config, model: e.currentTarget.value }); setResult(''); }} required disabled={busy || !ready} /></label>
      <label className={styles.label}>API Key<input data-ai-control="input" className={styles.input} type='password' autoComplete='new-password' placeholder={config.hasKey ? '已保存密钥，地址不变时可留空保留' : '填写模型密钥，仅保存在服务器'} value={config.apiKey || ''} onChange={e => { setConfig({ ...config, apiKey: e.currentTarget.value }); setResult(''); }} disabled={busy || !ready} /></label>
      <div className={styles.actions}><button data-ai-control="button" type='button' className={styles.secondary} onClick={() => void save(true)} disabled={busy || !ready}>测试连接</button><button data-ai-control="button" type='submit' className={styles.primary} disabled={busy || !ready}>{busy ? '正在检测…' : '检测并保存'}</button></div>
    </form>}
    {error && <div className={styles.error} role='alert'>{error}</div>}
    {result && <div className={styles.success} role='status'>{result}</div>}
  </section>;
}
