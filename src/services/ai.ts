import type { Transaction } from '@/types';
import { request } from './request';
import { PUBLIC_ORIGIN, session } from './session';

export interface AiSchema { type: string; title?: string; properties?: Record<string, AiSchema>; required?: string[]; items?: AiSchema; enum?: string[]; maxItems?: number }
export interface AiIntent { action: string; parameters?: Record<string, any>; [key: string]: any }
export interface AiCapability { action: string; title: string; mode: 'read' | 'write' | 'navigate' | 'print'; schema: AiSchema; destructive: boolean }
export interface AiStatus { mode: 'model' | 'rules' | 'misconfigured'; model: string | null; message: string; canConfigure?: boolean; settingsAvailable?: boolean; voice?: { available: boolean; maxSeconds: number; maxBytes: number }; photos?: { available: boolean; maxCount: number; maxBytes: number } }
export interface AiDocument { title: string; filename: string; html: string; transaction_id?: number }
export interface AiPlan {
  transcript?: string; durationSeconds?: number; input_type?: 'voice' | 'photo';
  status: 'ready' | 'needs_input' | 'unsupported' | 'result' | 'navigate'; reply: string; title?: string;
  revision: number; intent: AiIntent; command?: AiIntent; schema?: AiSchema; destructive?: boolean;
  preview?: Record<string, any>; missing_fields?: string[];
  candidates?: Array<{ path: string; kind: string; items: Array<{ id: number | string; name: string; specification?: string; unit?: string; stock?: number }> }> | Record<string, { total?: number; items: Array<{ id: number | string; name: string; specification?: string; unit?: string; stock?: number }> }>;
  result?: { title: string; items: Record<string, any>[]; total: number; page?: number; page_size?: number };
  navigation?: { url: string; title: string };
}
export interface AiResult { status: 'completed' | 'print_ready'; reply: string; action: string; document?: AiDocument; transaction?: Transaction; result?: any; revision: number }
export const getAiStatus = () => request<AiStatus>({ url: '/api/ai/status' });
export const getAiCapabilities = () => request<{ capabilities: AiCapability[] }>({ url: '/api/ai/tools' });
export const testAiConnection = () => request<{ connected: boolean; message: string }>({ url: '/api/ai/connection-test', method: 'POST', readOnly: true, retryAcrossOrigins: false, timeout: 35000, data: {} });
export interface AiConnection { baseUrl: string; model: string; hasKey?: boolean; apiKey?: string; reasoningEffort?: string }
// Configuration credentials travel only to our HTTPS server, never a fallback
// HTTP origin, local storage, the model provider or the ordinary request cache.
export async function aiSettingsRequest<T>(url: string, method: 'GET' | 'POST' | 'PUT', data?: unknown, token = session()?.token || ''): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch(`${PUBLIC_ORIGIN}/api${url}`, { method, redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json();
    if (!response.ok || !body.success) throw new Error(body.message || '模型设置请求失败');
    return body.data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('模型连接测试超时，请稍后重试');
    throw error;
  } finally { clearTimeout(timer); }
}
export const prepareAiCommand = (message: string, context?: AiIntent, images: string[] = []) => request<AiPlan>({
  url: '/api/ai/command', method: 'POST', readOnly: true, retryAcrossOrigins: false, timeout: 55000,
  data: { message, ...(context ? { context } : {}), ...(images.length ? { images } : {}) }
});
export const prepareAiPhoto = (images: string[], message = '请识别入库单，整理入库明细', context?: AiIntent) => request<AiPlan>({
  url: '/api/ai/photo', method: 'POST', readOnly: true, retryAcrossOrigins: false, timeout: 55000,
  data: { images, message, ...(context ? { context } : {}) }
});
export const prepareAiVoice = (audio: string, context?: AiIntent, images: string[] = [], message = '') => request<AiPlan>({
  url: '/api/ai/voice', method: 'POST', readOnly: true, retryAcrossOrigins: false, timeout: 110000,
  data: { audio, ...(context ? { context } : {}), ...(images.length ? { images } : {}), ...(message.trim() ? { message: message.trim() } : {}) }
});
export const reviseAiCommand = (intent: AiIntent) => request<AiPlan>({ url: '/api/ai/prepare', method: 'POST', readOnly: true, data: { intent } });
export const executeAiCommand = (command: AiIntent, revision: number, readOnly = false) => request<AiResult>({
  url: '/api/ai/execute', method: 'POST', data: command,
  ...(readOnly || command.action === 'print' ? { readOnly: true } : { expectedRevision: revision })
});

export async function readAiPhoto(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error('原图过大，请选择小于 20 MB 的图片');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPEG、PNG 或 WebP 图片');
  const url = URL.createObjectURL(file);
  try {
    const picture = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('无法读取图片，请换一张清晰照片')); img.src = url;
    });
    const scale = Math.min(1, 1800 / Math.max(picture.naturalWidth, picture.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前设备不支持图片处理');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
    let data = canvas.toDataURL('image/jpeg', 0.9);
    if (data.length > 2796200) data = canvas.toDataURL('image/jpeg', 0.7);
    if (!data.startsWith('data:image/jpeg;base64,') || data.length > 2796200) throw new Error('图片过大，请裁剪单据后重试');
    return data;
  } finally { URL.revokeObjectURL(url); }
}

export async function readAiAudio(file: Blob, name = ''): Promise<string> {
  if (!file.size || file.size > 6 * 1024 * 1024) throw new Error('语音文件须大于 0 字节且不超过 6 MiB，每条最多 60 秒');
  const aliases: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'video/mp4': 'audio/mp4', 'video/webm': 'audio/webm' };
  const extensions: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', webm: 'audio/webm' };
  const declared = file.type.split(';')[0].toLowerCase();
  const mime = aliases[declared] || (Object.values(extensions).includes(declared) ? declared : extensions[name.split('.').pop()?.toLowerCase() || '']);
  if (!mime) throw new Error('请选择 WAV、MP3、M4A、AAC、OGG 或 WebM 语音文件');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取语音失败，请重新选择'));
    reader.onabort = () => reject(new Error('已取消读取语音'));
    reader.readAsDataURL(new Blob([file], { type: mime }));
  });
}
