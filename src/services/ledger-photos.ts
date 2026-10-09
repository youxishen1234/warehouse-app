import Taro from '@tarojs/taro';
import { request } from './request';
import type { LedgerAttachment, LedgerAttachmentKind } from '@/types';

export const photoKinds: { value: LedgerAttachmentKind; label: string }[] = [
  { value: 'delivery', label: '送货单' }, { value: 'signed', label: '签收单' }, { value: 'payment', label: '收款凭证' }
];
export const MAX_PHOTOS = 20;
const MAX_BYTES = 12 * 1024 * 1024;
export type PhotoDraft = { client_id: string; kind: LedgerAttachmentKind; name: string; data: string; error?: string };
export const photoLabel = (kind: LedgerAttachmentKind) => photoKinds.find(item => item.value === kind)?.label || '凭证';
export const listLedgerPhotos = (id: number) => request<LedgerAttachment[]>({ url: `/api/ledger/${id}/attachments` });
export const readLedgerPhoto = (id: number, attachmentId: string) => request<{ data: string }>({ url: `/api/ledger/${id}/attachments/${attachmentId}/content`, timeout: 60000, retryAcrossOrigins: false });
export const uploadLedgerPhoto = (id: number, draft: PhotoDraft) => request<LedgerAttachment>({
  url: `/api/ledger/${id}/attachments`, method: 'POST', data: { client_id: draft.client_id, kind: draft.kind, name: draft.name, data: draft.data },
  requestIdentity: `photo:${draft.client_id}`, timeout: 90000, retryAcrossOrigins: false
});
const clientId = () => `photo-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const readFile = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('照片读取失败，请重新选择'));
  reader.readAsDataURL(file);
});
export async function browserPhotoDraft(file: File, kind: LedgerAttachmentKind): Promise<PhotoDraft> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} 超过 12 MB，请选择较小的原图`);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('支持 JPG、PNG、WebP；请将 HEIC 照片另存为 JPG 后上传');
  return { client_id: clientId(), kind, name: file.name.slice(0, 160), data: await readFile(file) };
}
export async function chooseNativePhotos(kind: LedgerAttachmentKind, count: number, camera: boolean): Promise<PhotoDraft[]> {
  const result = await Taro.chooseImage({ count: Math.min(count, 9), sizeType: ['original'], sourceType: camera ? ['camera'] : ['album'] });
  const drafts: PhotoDraft[] = [];
  for (let index = 0; index < result.tempFilePaths.length; index++) {
    const filePath = result.tempFilePaths[index];
    const file = result.tempFiles?.[index];
    if (file?.size > MAX_BYTES) throw new Error('每张照片不能超过 12 MB');
    const base64 = await new Promise<string>((resolve, reject) => Taro.getFileSystemManager().readFile({ filePath, encoding: 'base64', success: contents => resolve(String(contents.data)), fail: () => reject(new Error('照片读取失败，请检查相册权限后重试')) }));
    const mime = base64.startsWith('/9j/') ? 'image/jpeg' : base64.startsWith('iVBORw0KGgo') ? 'image/png' : base64.startsWith('UklGR') ? 'image/webp' : '';
    if (!mime) throw new Error('请选择 JPG、PNG 或 WebP 照片');
    if (base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('每张照片不能超过 12 MB');
    drafts.push({ client_id: clientId(), kind, name: filePath.split('/').pop()?.slice(0, 160) || `照片-${index + 1}.jpg`, data: `data:${mime};base64,${base64}` });
  }
  return drafts;
}

// This small display derivative is kept only in memory. The uploaded original
// remains byte-for-byte unchanged and is fetched separately for full preview.
export async function photoThumbnail(data: string): Promise<string> {
  if (typeof document === 'undefined') return data;
  const image = new window.Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('图片无法预览')); image.src = data; });
  const scale = Math.min(1, 360 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return data;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

export async function savePhotoOriginal(data: string, name: string) {
  if (typeof document === 'undefined') throw new Error('请在浏览器打开流水详情后保存原图');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!match) throw new Error('原图内容无效，请重新加载');
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const blob = new Blob([bytes], { type: match[1] });
  const file = new File([blob], name, { type: blob.type });
  if ((globalThis as any).Capacitor?.isNativePlatform?.()) {
    if (!navigator.canShare?.({ files: [file] })) throw new Error('当前设备不支持保存原图，请在浏览器打开后保存');
    try { await navigator.share({ files: [file] }); } catch (error) { if (error?.name !== 'AbortError') throw error; }
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
