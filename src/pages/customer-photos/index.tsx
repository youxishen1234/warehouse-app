import { useCallback, useEffect, useRef, useState } from 'react';
import Taro, { useRouter } from '@tarojs/taro';
import { browserPhotoDraft, chooseNativePhotos, MAX_CUSTOMER_PHOTO_BYTES, MAX_PHOTOS, photoThumbnail, savePhotoOriginal } from '@/services/ledger-photos';
import type { PhotoDraft } from '@/services/ledger-photos';
import { listCustomerPhotos, readCustomerPhoto, uploadCustomerPhoto } from '@/services/customer-photos';
import type { CustomerPhoto } from '@/services/customer-photos';
import styles from './index.module.scss';

export default function CustomerPhotosPage() {
  const { params } = useRouter();
  const customerId = Number(params.id);
  const customerName = params.name || '客户';
  const [items, setItems] = useState<CustomerPhoto[]>([]);
  const [drafts, setDrafts] = useState<PhotoDraft[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [viewer, setViewer] = useState<{ name: string; data?: string; attachment?: CustomerPhoto }>();
  const loaded = useRef(new Set<string>());
  const load = useCallback(async () => {
    if (!Number.isSafeInteger(customerId) || customerId < 1) { setError('客户编号无效'); return; }
    try { setItems(await listCustomerPhotos(customerId)); }
    catch (issue) { setError(issue instanceof Error ? issue.message : '照片加载失败'); }
  }, [customerId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    for (const item of items) {
      if (loaded.current.has(item.id)) continue;
      loaded.current.add(item.id);
      void readCustomerPhoto(customerId, item.id).then(content => photoThumbnail(content.data)).then(src => {
        if (active) setThumbnails(previous => ({ ...previous, [item.id]: src }));
      }).catch(() => { loaded.current.delete(item.id); });
    }
    return () => { active = false; };
  }, [customerId, items]);
  const viewerAttachmentId = viewer?.attachment?.id;
  useEffect(() => {
    if (!viewerAttachmentId) return;
    let active = true;
    const attachmentId = viewerAttachmentId;
    void readCustomerPhoto(customerId, attachmentId).then(content => {
      if (active) setViewer(current => current?.attachment?.id === attachmentId ? { ...current, data: content.data } : current);
    }).catch(issue => { if (active) setError(issue instanceof Error ? issue.message : '原图读取失败'); });
    return () => { active = false; };
  }, [customerId, viewerAttachmentId]);
  const accept = async (files: File[]) => {
    const next: PhotoDraft[] = [];
    for (const file of files.slice(0, Math.max(0, MAX_PHOTOS - items.length - drafts.length))) {
      try { next.push(await browserPhotoDraft(file, 'delivery', MAX_CUSTOMER_PHOTO_BYTES)); }
      catch (issue) { setError(issue instanceof Error ? issue.message : '照片读取失败'); }
    }
    setDrafts(previous => [...previous, ...next]);
  };
  const choose = async (camera: boolean) => {
    setError('');
    try {
      if (typeof document !== 'undefined') {
        const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.multiple = !camera;
        if (camera) input.setAttribute('capture', 'environment');
        input.onchange = () => { const files = Array.from(input.files || []); input.remove(); void accept(files); };
        input.addEventListener('cancel', () => input.remove(), { once: true }); document.body.appendChild(input); input.click(); return;
      }
      const photos=await chooseNativePhotos('delivery', Math.min(camera ? 1 : 9, MAX_PHOTOS - items.length - drafts.length), camera, MAX_CUSTOMER_PHOTO_BYTES); setDrafts(previous => [...previous, ...photos]);
    } catch (issue) { if (!/cancel|取消/i.test(String((issue as any)?.errMsg || issue))) setError(issue instanceof Error ? issue.message : '拍照或选择照片失败'); }
  };
  const upload = async () => {
    if (!drafts.length || busy) return;
    setBusy(true); setError(''); let success = 0;
    for (const draft of drafts) {
      try {
        const saved = await uploadCustomerPhoto(customerId, draft);
        if (!saved?.id || saved.customer_id !== customerId) throw new Error('服务器未确认客户关联，请保留原图后重试');
        setItems(previous => previous.some(item => item.id === saved.id) ? previous : [...previous, saved]);
        setDrafts(previous => previous.filter(item => item.client_id !== draft.client_id)); success++;
      } catch (issue) { setError(issue instanceof Error ? issue.message : '上传失败，请使用同一张照片重试'); break; }
    }
    setMessage(success ? '照片已保存到客户档案' : ''); setBusy(false);
  };
  const download = async () => {
    if (!viewer?.data) return;
    try { await savePhotoOriginal(viewer.data, viewer.name); }
    catch (issue) { Taro.showToast({ title: issue instanceof Error ? issue.message : '保存原图失败', icon: 'none' }); }
  };
  return <main className={styles.page}>
    <header className={styles.header}><h1>{customerName}</h1><p>拍摄三联送货单，上传并保存到客户档案</p></header>
    <section className={styles.card}>
      <div className={styles.sectionTitle}>上传客户单据照片 · {items.length}/{MAX_PHOTOS}</div>
      <div className={styles.actions}><button type='button' disabled={busy} onClick={() => void choose(true)}>拍照</button><button type='button' disabled={busy} onClick={() => void choose(false)}>从相册选择</button></div>
      <p>保留相机原图，不缩小、不压缩。支持 JPG、PNG、WebP，单张最大 24 MB；每位客户最多保存 {MAX_PHOTOS} 张。</p>
      {drafts.map(item => <p key={item.client_id}>{item.name} · 待上传</p>)}
      {drafts.length > 0 && <button type='button' className={styles.primary} disabled={busy} onClick={() => void upload()}>{busy ? '正在上传…' : '上传照片到客户档案'}</button>}
      {error && <p role='alert' className={styles.error}>{error}</p>}{message && <p role='status' className={styles.message}>{message}</p>}
    </section>
    <section className={styles.card}><div className={styles.sectionTitle}>已上传 · {items.length} 张</div>
      {items.length ? <div className={styles.grid}>{items.map(item => <button type='button' className={styles.photo} key={item.id} onClick={() => setViewer({ name: item.name, attachment: item })}><img src={thumbnails[item.id] || ''} alt='' /><span>{item.name}<br />{new Date(item.created_at).toLocaleString('zh-CN')}</span></button>)}</div> : <p className={styles.empty}>还没有照片，可拍照或从相册选择</p>}
    </section>
    {viewer && <div className={styles.viewer} role='dialog' aria-modal='true' aria-label='客户单据原图'><header className={styles.viewerHeader}><span>{viewer.name}</span><button type='button' onClick={() => setViewer(undefined)}>关闭</button></header><div className={styles.canvas}>{viewer.data ? <img src={viewer.data} alt={viewer.name} /> : <p>正在读取原图…</p>}</div><footer className={styles.viewerActions}><button type='button' onClick={() => void download()} disabled={!viewer.data}>保存原图</button></footer></div>}
  </main>;
}






