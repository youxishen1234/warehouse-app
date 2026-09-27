import Taro from '@tarojs/taro';
import { getBaseUrl } from './request';
import { session } from './session';

export async function downloadCsv(path: string, filename: string) {
  const token = session()?.token;
  if (!token) throw new Error('请等待仓库连接完成');
  if (typeof document !== 'undefined') {
    const response = await fetch(`${getBaseUrl()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('导出失败，请刷新后重试');
    const blob = await response.blob();
    const file = new File([blob], filename, { type: 'text/csv' });
    if ((globalThis as any).Capacitor?.isNativePlatform?.()) {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
      throw new Error('当前设备不支持保存 CSV，请在浏览器中打开后导出');
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return;
  }
  const result = await Taro.downloadFile({ url: `${getBaseUrl()}${path}`, header: { Authorization: `Bearer ${token}` } });
  if (result.statusCode !== 200) throw new Error('导出失败');
  await Taro.shareFileMessage({ filePath: result.tempFilePath, fileName: filename });
}
