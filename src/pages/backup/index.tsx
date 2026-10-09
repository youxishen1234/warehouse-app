import { useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getBackup, restoreBackup } from '@/services/api';
import styles from './index.module.scss';

type BrowserFileInput = HTMLInputElement & { files: FileList | null };

function downloadJson(payload: string, filename: string): boolean {
  const browser = globalThis as any;
  if (!browser.document || !browser.URL || !browser.Blob) return false;
  const link = browser.document.createElement('a');
  const url = browser.URL.createObjectURL(new browser.Blob([payload], { type: 'application/json;charset=utf-8' }));
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  browser.setTimeout(() => browser.URL.revokeObjectURL(url), 1000);
  return true;
}

export default function BackupPage() {
  const [status, setStatus] = useState('导出后会直接下载 JSON 文件；恢复时请选择之前导出的 JSON 文件。');
  const [busy, setBusy] = useState(false);

  const exportBackup = async () => {
    try {
      setBusy(true);
      const result = await getBackup();
      const payload = JSON.stringify(result, null, 2);
      const filename = `warehouse-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const downloaded = downloadJson(payload, filename);
      if (!downloaded) await Taro.setClipboardData({ data: payload });
      setStatus(downloaded ? `已下载 ${filename}` : '当前平台不支持直接下载，备份内容已复制到剪贴板。');
      Taro.showToast({ title: downloaded ? '备份已下载' : '备份已复制', icon: 'success' });
    } catch (error) {
      Taro.showToast({ title: (error as any)?.message || '导出失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  };

  const restorePayload = async (raw: string, filename: string) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      const payload = parsed && typeof parsed === 'object' && 'data' in parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      const confirm = await Taro.showModal({
        title: '确认恢复',
        content: `恢复 ${filename} 会覆盖当前共享数据，请先确认已有最新备份。`,
        confirmText: '继续恢复',
        cancelText: '取消'
      });
      if (!confirm.confirm) return;
      setBusy(true);
      await restoreBackup(payload);
      setStatus(`已从 ${filename} 恢复共享数据。`);
      Taro.showToast({ title: '恢复成功', icon: 'success' });
    } catch (error) {
      Taro.showToast({ title: (error as any)?.message || '恢复失败，文件不是有效备份', icon: 'none' });
    } finally {
      setBusy(false);
    }
  };

  const chooseRestoreFile = () => {
    if (busy) return;
    const browser = globalThis as any;
    if (!browser.document || !browser.FileReader) {
      Taro.showToast({ title: '请在支持文件选择的设备上恢复 JSON', icon: 'none' });
      return;
    }
    const input = browser.document.createElement('input') as BrowserFileInput;
    input.type = 'file';
    input.accept = '.json,application/json,text/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setStatus(`正在读取 ${file.name}…`);
      const reader = new browser.FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        void restorePayload(raw, file.name);
      };
      reader.onerror = () => Taro.showToast({ title: '读取备份文件失败', icon: 'none' });
      reader.readAsText(file, 'utf-8');
    };
    input.click();
  };

  return (
    <ScrollView scrollY className={styles.page}>
      <Text className={styles.title}>备份与恢复</Text>
      <Text className={styles.hint}>备份包含商品、客户、供应商、客户尺寸本、纸板批次、库存、流水、订单和盘点记录。旧版备份没有尺寸本时，会保留当前尺寸本。恢复请求默认支持 64 MiB，服务器可按需配置。</Text>
      <View className={styles.actions}>
        <View className={styles.primary} onClick={busy ? undefined : exportBackup}>{busy ? '处理中…' : '导出备份 JSON'}</View>
        <View className={styles.secondary} onClick={busy ? undefined : chooseRestoreFile}>选择 JSON 恢复</View>
      </View>
      <Text className={styles.hint}>{status}</Text>
    </ScrollView>
  );
}
