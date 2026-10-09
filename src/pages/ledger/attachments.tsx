import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '@/components/Icon';
import type { LedgerAttachment, LedgerAttachmentKind, LedgerEntry } from '@/types';
import { browserPhotoDraft, chooseNativePhotos, MAX_PHOTOS, photoKinds, photoLabel, photoThumbnail, readLedgerPhoto, savePhotoOriginal, uploadLedgerPhoto } from '@/services/ledger-photos';
import type { PhotoDraft } from '@/services/ledger-photos';
import Button from './button';
import styles from './attachments.module.scss';

type Props = {
  entry: LedgerEntry;
  drafts: PhotoDraft[];
  onDrafts: (id: number, update: (items: PhotoDraft[]) => PhotoDraft[]) => void;
  onSaved: (id: number, attachment: LedgerAttachment) => void;
  onBusy: (busy: boolean) => void;
};
type Viewer = { name: string; data?: string; error?: string; attachment?: LedgerAttachment };

export default function LedgerAttachments({ entry, drafts, onDrafts, onSaved, onBusy }: Props) {
  const [kind, setKind] = useState<LedgerAttachmentKind>(entry.type === 'income' || entry.type === 'settlement' ? 'payment' : 'signed');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [message, setMessage] = useState('');
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [thumbErrors, setThumbErrors] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [zoom, setZoom] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loaded = useRef(new Set<string>());
  const saved = useMemo(() => entry.attachments || [], [entry.attachments]);
  const remaining = Math.max(0, MAX_PHOTOS - saved.length - drafts.length);

  useEffect(() => { alive.current = true; return () => { alive.current = false; inputRef.current?.remove(); }; }, []);
  useEffect(() => { onBusy(busy || Boolean(viewer)); }, [busy, viewer, onBusy]);
  useEffect(() => {
    if (!viewer || typeof document === 'undefined') return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setViewer(null); }
    };
    document.addEventListener('keydown', close, true);
    return () => document.removeEventListener('keydown', close, true);
  }, [viewer]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      for (const item of saved) {
        if (cancelled || !alive.current) return;
        if (loaded.current.has(item.id)) continue;
        try {
          const content = await readLedgerPhoto(entry.id, item.id);
          const thumb = await photoThumbnail(content.data);
          if (cancelled || !alive.current) return;
          loaded.current.add(item.id);
          setThumbnails(current => ({ ...current, [item.id]: thumb }));
        } catch {
          if (!cancelled && alive.current) setThumbErrors(current => ({ ...current, [item.id]: true }));
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [entry.id, saved]); // Fetch photo bytes only inside the open detail sheet.

  const acceptFiles = async (files: File[]) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setMessage('正在读取照片…');
    const next: PhotoDraft[] = []; const errors: string[] = [];
    for (const file of files.slice(0, remaining)) {
      try { next.push(await browserPhotoDraft(file, kind)); }
      catch (error) { errors.push(error?.message || '照片读取失败'); }
    }
    if (files.length > remaining) errors.push(`每笔流水最多 ${MAX_PHOTOS} 张，超出的照片未添加`);
    if (alive.current) {
      onDrafts(entry.id, current => [...current, ...next]);
      setMessage(errors.join('；')); setBusy(false);
    }
    busyRef.current = false;
  };

  const choose = async (camera = false) => {
    if (!remaining || busyRef.current) return;
    setMessage('');
    if (typeof document !== 'undefined') {
      inputRef.current?.remove();
      const input = document.createElement('input'); inputRef.current = input;
      input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.multiple = !camera;
      if (camera) input.setAttribute('capture', 'environment');
      input.style.display = 'none';
      input.addEventListener('change', () => { const files = Array.from(input.files || []); input.remove(); void acceptFiles(files); }, { once: true });
      input.addEventListener('cancel', () => input.remove(), { once: true });
      document.body.appendChild(input); input.click();
      return;
    }
    busyRef.current = true; setBusy(true);
    try { const photos = await chooseNativePhotos(kind, remaining, camera); onDrafts(entry.id, current => [...current, ...photos]); }
    catch (error) { if (!/cancel|取消/i.test(String(error?.errMsg || error?.message))) setMessage(error?.message || '无法打开相册或相机，请允许照片访问后重试'); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  const upload = async () => {
    if (busyRef.current || !drafts.length) return;
    busyRef.current = true; setBusy(true); setMessage('');
    let success = 0;
    for (const draft of drafts) {
      setUploading(draft.client_id);
      try {
        const attachment = await uploadLedgerPhoto(entry.id, draft);
        if (!attachment?.id || attachment.ledger_id !== entry.id) throw new Error('服务器未确认照片关联，请保留照片并重试');
        onSaved(entry.id, attachment);
        onDrafts(entry.id, current => current.filter(item => item.client_id !== draft.client_id));
        success++;
      } catch (error) {
        onDrafts(entry.id, current => current.map(item => item.client_id === draft.client_id ? { ...item, error: error?.message || '上传失败，请重试' } : item));
        // Keep the remaining files queued after a failure, including an uncertain
        // commit. The same client ID and unchanged bytes are reused on retry.
        break;
      }
    }
    setUploading(''); setMessage(success ? `已保存 ${success} 张原图，待人工核对` : '照片未确认保存，请重试');
    busyRef.current = false; setBusy(false);
  };

  const preview = async (attachment: LedgerAttachment) => {
    setZoom(false); setViewer({ name: attachment.name, attachment });
    try {
      const content = await readLedgerPhoto(entry.id, attachment.id);
      if (alive.current) setViewer(current => current?.attachment?.id === attachment.id ? { ...current, data: content.data } : current);
    } catch (error) { if (alive.current) setViewer(current => current?.attachment?.id === attachment.id ? { ...current, error: error?.message || '原图加载失败' } : current); }
  };
  const download = async () => {
    if (!viewer?.data || downloading) return;
    setDownloading(true);
    try { await savePhotoOriginal(viewer.data, viewer.name); }
    catch (error) { Taro.showToast({ title: error?.message || '原图保存失败，请重试', icon: 'none' }); }
    finally { setDownloading(false); }
  };

  return <View className={styles.panel}>
    <View className={styles.heading}><View><Text className={styles.title}>单据凭证</Text><Text className={styles.count}>{saved.length} 张</Text></View><Text className={styles.status}>{saved.length ? '已上传 · 待核对' : '待添加照片'}</Text></View>
    <Text className={styles.description}>拍全单号、金额与签字，可添加多页或正反面。</Text>
    {saved.length > 0 && <View className={styles.grid}>{saved.map((item, index) => <Button key={item.id} className={styles.photoCard} aria-label={`查看${photoLabel(item.kind)}第 ${index + 1} 张`} onClick={() => preview(item)}>
      <View className={styles.thumbnail}>{thumbnails[item.id] ? <Image src={thumbnails[item.id]} mode='aspectFit' /> : <Text className={styles.thumbPlaceholder}>{thumbErrors[item.id] ? '点此重试原图' : '加载照片…'}</Text>}<Text className={styles.photoNumber}>{String(index + 1).padStart(2, '0')}</Text></View>
      <View className={styles.caption}><Text>{photoLabel(item.kind)}</Text><Text>查看原图</Text></View>
    </Button>)}</View>}
    <View className={styles.kindTabs}>{photoKinds.map(item => <Button key={item.value} disabled={busy} aria-pressed={kind === item.value} className={kind === item.value ? styles.kindActive : ''} onClick={() => setKind(item.value)}>{item.label}</Button>)}</View>
    <View className={styles.addActions}><Button className={styles.choose} disabled={busy || !remaining} onClick={() => choose()}><Icon name='plus' color='#397457' /><Text>添加{photoLabel(kind)}照片</Text></Button><Button className={styles.camera} disabled={busy || !remaining} onClick={() => choose(true)}>拍照</Button></View>
    <Text className={styles.limits}>原图保存 · JPG / PNG / WebP · 单张 ≤ 12 MB · 最多 20 张</Text>
    {drafts.length > 0 && <View className={styles.pending}>
      <View className={styles.pendingHeading}><Text>待上传 {drafts.length} 张</Text><Text>仅保留在当前页面</Text></View>
      {drafts.map(draft => <View className={styles.draft} key={draft.client_id}>
        <Button className={styles.draftPreview} aria-label={`预览待上传照片 ${draft.name}`} disabled={busy} onClick={() => { setZoom(false); setViewer({ name: draft.name, data: draft.data }); }}><Image src={draft.data} mode='aspectFit' /></Button>
        <View className={styles.draftInfo}><Text className={styles.filename}>{draft.name}</Text><Text className={draft.error ? styles.error : styles.draftStatus}>{uploading === draft.client_id ? '正在保存原图…' : draft.error || `${photoLabel(draft.kind)} · 待上传`}</Text></View>
        <Button className={styles.remove} disabled={busy} aria-label={`移除待上传照片 ${draft.name}`} onClick={() => onDrafts(entry.id, current => current.filter(item => item.client_id !== draft.client_id))}>×</Button>
      </View>)}
      <Button className={styles.upload} disabled={busy} onClick={upload}>{busy ? '处理中…' : drafts.some(item => item.error) ? '重试上传' : `上传 ${drafts.length} 张照片`}</Button>
    </View>}
    {message && <View className={styles.message} role='status'><Text>{message}</Text></View>}
    <View className={styles.note}><Icon name='clipboard' color='#8c997d' /><Text>照片仅作凭证，上传不会增加收款或改变库存。</Text></View>
    {viewer && <View className={styles.viewer} role='dialog' aria-modal='true' aria-label='凭证原图' onClick={e => e.stopPropagation()}>
      <View className={styles.viewerHeader}><View><Text>{viewer.attachment ? photoLabel(viewer.attachment.kind) : '待上传照片'}</Text><Text className={styles.viewerName}>{viewer.name}</Text></View><Button aria-label='关闭凭证预览' onClick={() => setViewer(null)}>×</Button></View>
      <View className={`${styles.viewerCanvas} ${zoom ? styles.zoomed : ''}`}>
        {viewer.data ? <Image className={styles.original} src={viewer.data} mode={zoom ? 'widthFix' : 'aspectFit'} /> : <View className={styles.viewerLoading}><Text>{viewer.error || '正在加载原图…'}</Text>{viewer.error && viewer.attachment && <Button onClick={() => preview(viewer.attachment!)}>重新加载原图</Button>}</View>}
      </View>
      <View className={styles.viewerFooter}><Button disabled={!viewer.data} onClick={() => setZoom(value => !value)}>{zoom ? '适应屏幕' : '放大查看'}</Button><Button disabled={!viewer.data || downloading} onClick={download}>{downloading ? '保存中…' : '保存原图'}</Button></View>
    </View>}
  </View>;
}
