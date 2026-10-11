/* eslint-disable react/forbid-elements */
import { useEffect, useRef, useState } from 'react';
import { getRemoteDevice, getRemotePrintJob, readPrintAttempt, readPrintPair, savePrintAttempt, savePrintPair, submitRemotePrint } from '@/services/remote-print';
import type { RemoteDevice, RemoteJob } from '@/services/remote-print';
import type { SavedPrintNote } from '@/services/print-notes';
import styles from './index.module.scss';
export default function RemotePrint({ saved, paper }: {saved?:SavedPrintNote;paper:string}) {
 const [code,setCode]=useState(()=>new URLSearchParams(location.hash.split('?')[1]||'').get('print_pair')||''),[paired,setPaired]=useState(!!readPrintPair()),[device,setDevice]=useState<RemoteDevice>(),[job,setJob]=useState<RemoteJob>(),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const attempt=useRef<{id:string;fingerprint:string}>();
 useEffect(()=>{if(!paired)return;let active=true;const refresh=async()=>{try{const d=await getRemoteDevice();if(active)setDevice(d);}catch(e){if(active)setMessage(e instanceof Error?e.message:'打印电脑连接失败');}};void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{active=false;clearInterval(timer);};},[paired]);
 useEffect(()=>{if(!job||!['waiting','processing'].includes(job.status))return;let active=true;const timer=setInterval(()=>{getRemotePrintJob(job.id).then(result=>{if(active)setJob(result);}).catch(()=>{});},2500);return()=>{active=false;clearInterval(timer);};},[job]);
 const pair=async()=>{setBusy(true);setMessage('');try{if(!/^[a-f0-9]{64}$/.test(code.trim()))throw new Error('请粘贴电脑提供的完整配对码');savePrintPair(code.trim());setDevice(await getRemoteDevice());setPaired(true);setCode('');}catch(e){setMessage(e instanceof Error?e.message:'配对失败');}finally{setBusy(false);}};
 const send=async()=>{if(!saved)return;setBusy(true);setMessage('');try{const fingerprint=JSON.stringify({device:device?.id,id:saved.id,version:saved.version,paper});if(attempt.current?.fingerprint!==fingerprint){const id=readPrintAttempt(fingerprint)||'remote-'+crypto.randomUUID();savePrintAttempt(fingerprint,id);attempt.current={id,fingerprint};}setJob(await submitRemotePrint({id:attempt.current.id,note_id:saved.id,version:saved.version,paper}));}catch(e){setMessage(e instanceof Error?e.message:'结果未确认，请使用同一任务重试');}finally{setBusy(false);}};
 return <details className={styles.settings}><summary>远程打印到店里 {device?.online?(device.ready?'· 电脑在线':'· 打印机不可用'):'· 电脑离线'}</summary><div className={styles.settingsBody}>
 {!paired?<><p className={styles.muted}>粘贴打印电脑提供的配对码，即可用手机发送送货单。</p><input aria-label='打印电脑配对码' type='search' value={code} onChange={e=>setCode(e.target.value)} placeholder='粘贴配对码' /><button type='button' className={styles.secondary} disabled={busy} onClick={()=>void pair()}>连接打印电脑</button></>:<><p className={styles.muted}>{device?.name||'打印电脑'} · {device?.printer||'630K'}<br />电脑和打印机需保持开机。仅发送打印，不自动出库。</p>{!saved&&<p className={styles.muted}>请先保存单据，再发送远程打印。</p>}<button type='button' className={styles.primary} disabled={busy||!saved||!!job&&['waiting','processing','uncertain'].includes(job.status)} onClick={()=>void send()}>{busy?'正在发送…':'发送到630K'}</button><button type='button' className={styles.textButton} disabled={busy} onClick={()=>{savePrintPair('');setPaired(false);setDevice(undefined);}}>更换打印电脑</button></>}
 {job&&<p role='status' className={styles.notice}>{job.message}</p>}{message&&<p role='alert' className={styles.error}>{message}</p>}
 </div></details>;
}
