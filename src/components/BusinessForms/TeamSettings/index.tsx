/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useState } from 'react';
import { DemoPage, DemoSheet, DemoField } from '@/components/DemoUI';
import Taro, { usePullDownRefresh } from '@tarojs/taro';
import { accountApi, Member, session, setSession } from '@/services/session';
import { formatTime } from '@/utils/format';


const roles = ['admin','operator','viewer'];
const labels = ['管理员','操作员','只读'];
export default function Team() {
  const [adding, setAdding] = useState(false);
  const me = session()?.user;
  const [members,setMembers]=useState<Member[]>([]), [events,setEvents]=useState<any[]>([]);
  const [username,setUsername]=useState(''), [password,setPassword]=useState(''), [role,setRole]=useState(1);
  const [resetMember, setResetMember] = useState<string | null>(null), [resetPassword, setResetPassword] = useState('');
  const [message,setMessage]=useState(''), [busy,setBusy]=useState(false), [page,setPage]=useState(1), [total,setTotal]=useState(0);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const load=useCallback(async()=>{
    if(me?.role !== 'admin') { setLoading(false); return; }
    setLoading(true); setLoadError('');
    try {
      setMembers(await accountApi('/team'));
      const a=await accountApi(`/audit?page=${page}`);
      setEvents(a.items); setTotal(a.total);
    } catch(error) {
      const text = error instanceof Error ? error.message : '加载失败，请点击重试';
      setLoadError(text); setMessage(text);
    } finally { setLoading(false); }
  },[me?.role,page]);
  useEffect(()=>{load();},[load]);
  usePullDownRefresh(() => { load().finally(() => Taro.stopPullDownRefresh()); });
  const action=async(fn:()=>Promise<any>)=>{if(busy)return;setBusy(true);setMessage('');try{await fn();await load();setMessage('已保存');}catch(e){setMessage(e.message);}finally{setBusy(false);}};
  return <DemoPage title='团队与账号' action={me?.role === 'admin' ? <button type='button' className='demo-action' onClick={() => setAdding(true)}>＋ 新增</button> : undefined}>
    <div className='demo-card'><h3>{me?.username}</h3><p>{labels[roles.indexOf(me?.role || '')]}</p></div>
    {message && <div role='status' className='demo-note'>{message}</div>}
    {me?.role === 'admin' && <>
      <h3>团队成员</h3>
      {loading ? <p>正在加载…</p> : loadError ? <div className='demo-error' role='alert'>{loadError}<button type='button' className='demo-action' onClick={() => void load()}>重新读取</button></div> : !members.length ? <div className='demo-empty'>暂无成员</div> : members.map(member => <article className='demo-card' key={member.id}><h3>{member.username}</h3><DemoField label='成员权限'><select value={member.role} disabled={busy} onChange={event => void action(() => accountApi(`/team/${member.id}`, 'PUT', { role: event.target.value }))}>{roles.map((value, index) => <option key={value} value={value}>{labels[index]}</option>)}</select></DemoField><div className='demo-row'><label className='demo-check'><input type='checkbox' checked={!member.disabled} disabled={busy || member.id === me.id} onChange={event => void action(() => accountApi(`/team/${member.id}`, 'PUT', { disabled: !event.target.checked }))} />允许使用</label><button type='button' className='demo-action' disabled={busy} onClick={() => { setResetMember(member.id); setResetPassword(''); }}>重置密码</button></div></article>)}
      <details className='demo-more'><summary>操作记录</summary>{events.map((event, index) => <div className='demo-card' key={index}><h3>{event.actor_name} · {event.operation}</h3><p>{formatTime(event.time)}</p></div>)}{!events.length && <div className='demo-empty'>暂无记录</div>}<div className='demo-row'><button type='button' className='demo-action' disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil(total / 50))}</span><button type='button' className='demo-action' disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>下一页</button></div></details>
    </>}
    <button type='button' className='demo-primary demo-secondary' disabled={busy} onClick={() => setSession(null)}>重新连接仓库</button>
    {adding && <DemoSheet title='新增成员' busy={busy} onClose={() => setAdding(false)}><DemoField label='登录账号'><input aria-label='登录账号' value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /></DemoField><DemoField label='初始密码（至少12位）'><input type='password' aria-label='初始密码' value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></DemoField><DemoField label='成员权限'><select value={role} onChange={event => setRole(Number(event.target.value))}>{labels.map((label, index) => <option key={label} value={index}>{label}</option>)}</select></DemoField>{message && <div className='demo-error' role='alert'>{message}</div>}<button type='button' className='demo-primary' disabled={busy} onClick={() => void action(async () => { await accountApi('/team', 'POST', { username, password, role: roles[role] }); setUsername(''); setPassword(''); setAdding(false); })}>添加成员</button></DemoSheet>}
    {resetMember && <DemoSheet title='重置成员密码' busy={busy} onClose={() => setResetMember(null)}><DemoField label='新密码（至少12位）'><input type='password' aria-label='新密码' value={resetPassword} disabled={busy} onChange={event => setResetPassword(event.target.value)} /></DemoField>{message && <div className='demo-error' role='alert'>{message}</div>}<button type='button' className='demo-primary' disabled={busy} onClick={() => void action(async () => { if (resetPassword.length < 12) throw new Error('密码至少12位'); await accountApi(`/team/${resetMember}`, 'PUT', { password: resetPassword }); setResetMember(null); setResetPassword(''); })}>确认重置</button></DemoSheet>}
  </DemoPage>;
}
