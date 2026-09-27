import { useState } from 'react';
import { View, Text, Textarea, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getBackup, restoreBackup } from '@/services/api';
import styles from './index.module.scss';

export default function BackupPage() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const exportBackup = async () => {
    try {
      setBusy(true);
      const result = await getBackup();
      const payload = JSON.stringify(result, null, 2);
      setText(payload);
      await Taro.setClipboardData({ data: payload });
      const browser = globalThis as any;
      if (browser.document) {
        const link = browser.document.createElement('a');
        link.href = browser.URL.createObjectURL(new browser.Blob([payload], { type: 'application/json;charset=utf-8' }));
        link.download = `warehouse-backup-${new Date().toISOString().slice(0, 10)}.json`;
        link.click(); browser.URL.revokeObjectURL(link.href);
      }
      Taro.showToast({ title: '备份已导出并复制', icon: 'success' });
    } catch (error) { Taro.showToast({ title: (error as any)?.message || '导出失败', icon: 'none' }); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!text.trim()) { Taro.showToast({ title: '请粘贴备份 JSON', icon: 'none' }); return; }
    const confirm = await Taro.showModal({ title: '确认恢复', content: '恢复会覆盖当前共享数据，请确认已保存最新备份。' });
    if (!confirm.confirm) return;
    try {
      setBusy(true); const parsed = JSON.parse(text); await restoreBackup(parsed.data || parsed); Taro.showToast({ title: '恢复成功', icon: 'success' });
    } catch (error) { Taro.showToast({ title: (error as any)?.message || '恢复失败', icon: 'none' }); }
    finally { setBusy(false); }
  };
  return <ScrollView scrollY className={styles.page}><Text className={styles.title}>备份与恢复</Text><Text className={styles.hint}>备份包含商品、客户、供应商、库存、流水、订单和盘点记录。恢复前请先导出当前数据。</Text><View className={styles.actions}><View className={styles.primary} onClick={busy ? undefined : exportBackup}>{busy ? '处理中…' : '导出备份 JSON'}</View><View className={styles.secondary} onClick={busy ? undefined : restore}>恢复此 JSON</View></View><Textarea className={styles.textarea} value={text} onInput={e => setText(e.detail.value)} placeholder="导出的备份会显示在这里，也可以粘贴备份 JSON 后恢复" maxlength={1000000} /></ScrollView>;
}
