import React, { useEffect, useState } from 'react';
import { View, Text, Input, Picker, Button, Switch } from '@tarojs/components';
import Taro, { usePullDownRefresh } from '@tarojs/taro';
import { accountApi, Member, session, setSession } from '@/services/session';
import './style.scss';
const roles = ['admin','operator','viewer'];
const labels = ['管理员','操作员','只读'];
export default function Team() {
  const me = session()?.user;
  const [members,setMembers]=useState<Member[]>([]), [events,setEvents]=useState<any[]>([]);
  const [username,setUsername]=useState(''), [password,setPassword]=useState(''), [role,setRole]=useState(1);
  const [oldPassword,setOldPassword]=useState(''), [newPassword,setNewPassword]=useState('');
  const [message,setMessage]=useState(''), [busy,setBusy]=useState(false), [page,setPage]=useState(1), [total,setTotal]=useState(0);
  const load=async()=>{if(me?.role !== 'admin') return; try {setMembers(await accountApi('/team')); const a=await accountApi(`/audit?page=${page}`);setEvents(a.items);setTotal(a.total);}catch(e){setMessage(e.message);}};
  useEffect(()=>{load();},[page]);
  usePullDownRefresh(() => { load().finally(() => Taro.stopPullDownRefresh()); });
  const action=async(fn:()=>Promise<any>)=>{if(busy)return;setBusy(true);setMessage('');try{await fn();await load();setMessage('已保存');}catch(e){setMessage(e.message);}finally{setBusy(false);}};
  return <View className="team-page">
    <View className="team-heading"><Text>团队与账号</Text><Button size="mini" onClick={()=>Taro.switchTab({url:'/pages/mine/index'})}>完成</Button></View>
    <Text>{me?.username} · {labels[roles.indexOf(me?.role || '')]}</Text>
    <Text className="team-message">{message}</Text>
    {me?.role === 'admin' && <>
      <Text className="team-section">团队成员</Text>
      {members.length === 0 ? <Text className="team-message">暂无团队成员</Text> : members.map(u=><View className="team-member" key={u.id}>
        <Text>{u.username}</Text>
        <Picker value={roles.indexOf(u.role)} range={labels} disabled={busy} onChange={e=>action(()=>accountApi(`/team/${u.id}`,'PUT',{role:roles[Number(e.detail.value)]}))}><Text>{labels[roles.indexOf(u.role)]}</Text></Picker>
        <Switch checked={!u.disabled} disabled={busy || u.id === me.id} onChange={e=>action(()=>accountApi(`/team/${u.id}`,'PUT',{disabled:!e.detail.value}))} />
        <Button size="mini" disabled={busy} onClick={async()=>{const r=await Taro.showModal({title:'重置成员密码',editable:true,placeholderText:'新密码，至少12位'});if(r.confirm)action(()=>accountApi(`/team/${u.id}`,'PUT',{password:r.content}));}}>重置密码</Button>
      </View>)}
      <Text className="team-section">新增成员</Text>
      <Input placeholder="登录账号（字母、数字、下划线）" value={username} onInput={e=>setUsername(e.detail.value)} />
      <Input password placeholder="初始密码（至少12位）" value={password} onInput={e=>setPassword(e.detail.value)} />
      <Picker range={labels} value={role} onChange={e=>setRole(Number(e.detail.value))}><Text className="team-select">{labels[role]}</Text></Picker>
      <Button disabled={busy} onClick={()=>action(async()=>{await accountApi('/team','POST',{username,password,role:roles[role]});setUsername('');setPassword('');})}>添加成员</Button>
      <Text className="team-section">操作记录</Text>
      {events.length === 0 ? <Text className="team-message">暂无操作记录</Text> : events.map((e,i)=><View className="team-event" key={i}><Text>{e.actor_name} · {e.operation}</Text><Text>{new Date(e.time).toLocaleString()}</Text></View>)}
      <View className="team-heading"><Button size="mini" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</Button><Text>{page} / {Math.max(1,Math.ceil(total/50))}</Text><Button size="mini" disabled={page*50>=total} onClick={()=>setPage(page+1)}>下一页</Button></View>
    </>}
    <Text className="team-section">修改我的密码</Text>
    <Input password placeholder="当前密码" value={oldPassword} onInput={e=>setOldPassword(e.detail.value)} />
    <Input password placeholder="新密码（至少12位）" value={newPassword} onInput={e=>setNewPassword(e.detail.value)} />
    <Button disabled={busy} onClick={()=>action(async()=>{await accountApi('/auth/password','POST',{currentPassword:oldPassword,password:newPassword});setSession(null);})}>修改密码并重新登录</Button>
    <Button disabled={busy} onClick={()=>action(async()=>{await accountApi('/auth/logout','POST');setSession(null);})}>退出登录</Button>
  </View>;
}
