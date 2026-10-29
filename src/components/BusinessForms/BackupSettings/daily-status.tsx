import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import { DailyBackupStatus as BackupStatus, getDailyBackupStatus, getLatestDailyBackup, formatDailyBackupTime } from '@/services/daily-backup';
import styles from '@/components/BusinessForms/BackupSettings/daily-status.module.scss';

interface DailyBackupStatusProps {
  onDownload?: (payload: string, filename: string) => void | Promise<void>;
}

async function saveBackup(payload: string, filename: string): Promise<string> {
  const browser = globalThis as any;
  if (!browser.document || !browser.Blob || !browser.URL?.createObjectURL) {
    throw new Error('当前设备不支持直接保存备份，请在浏览器中打开后下载；备份内容不会复制到剪贴板。');
  }
  const blob = new browser.Blob([payload], { type: 'application/json;charset=utf-8' });
  if (browser.Capacitor?.isNativePlatform?.()) {
    const file = browser.File ? new browser.File([blob], filename, { type: 'application/json' }) : null;
    if (!file || !browser.navigator?.canShare?.({ files: [file] }) || !browser.navigator?.share) {
      throw new Error('当前设备不支持保存 JSON，请在浏览器中打开后下载。服务器上的备份不受影响。');
    }
    await browser.navigator.share({ files: [file] });
    return '已交给系统保存，请确认选择的保存位置。';
  }
  const url = browser.URL.createObjectURL(blob);
  const link = browser.document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    browser.document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    browser.setTimeout(() => browser.URL.revokeObjectURL(url), 30000);
  }
  return `已发起下载 ${filename}，请在下载列表查看。`;
}

function statusMessage(status: BackupStatus): string {
  if (!status.enabled) return '每日备份未启用';
  if (!status.active) return '定时任务未运行';
  if (status.running) return '服务器正在备份';
  if (status.lastError) return '最近一次备份失败';
  if (!status.lastSuccessAt) return '定时已启用 · 等待首次备份';
  if (!status.verified) return '最近副本尚未通过校验';
  return '每日备份正常';
}

export default function DailyBackupStatus({ onDownload }: DailyBackupStatusProps) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState('');
  const [downloadFailed, setDownloadFailed] = useState(false);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const refreshing = useRef(false);
  const downloadId = useRef(0);
  const downloadBusy = useRef(false);

  const refresh = useCallback(async () => {
    if (!mounted.current || refreshing.current) return;
    refreshing.current = true;
    const current = ++requestId.current;
    setLoading(true);
    setLoadError('');
    try {
      const next = await getDailyBackupStatus();
      if (mounted.current && current === requestId.current) setStatus(next);
    } catch (error) {
      if (mounted.current && current === requestId.current) {
        setStatus(null);
        setLoadError(error instanceof Error ? error.message : '暂时连接不上服务器，请稍后刷新。');
      }
    } finally {
      if (mounted.current && current === requestId.current) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestId.current += 1;
      downloadId.current += 1;
      refreshing.current = false;
      downloadBusy.current = false;
    };
  }, [refresh]);

  const download = async () => {
    if (downloadBusy.current || refreshing.current || !status?.lastSuccessAt || !status.verified || loadError) return;
    downloadBusy.current = true;
    const current = ++downloadId.current;
    setDownloading(true);
    setDownloadFailed(false);
    setDownloadMessage('正在读取服务器上的最近备份…');
    try {
      const result = await getLatestDailyBackup();
      if (!mounted.current || current !== downloadId.current) return;
      const filename = `warehouse-daily-backup-${new Date(result.exportedAt).toISOString().replace(/[:.]/g, '-')}.json`;
      const payload = JSON.stringify(result, null, 2);
      let message: string;
      if (onDownload) {
        await onDownload(payload, filename);
        message = `已交付 ${filename}，请确认保存完成。`;
      } else message = await saveBackup(payload, filename);
      if (mounted.current && current === downloadId.current) setDownloadMessage(message);
    } catch (error) {
      if (mounted.current && current === downloadId.current) {
        const cancelled = (error as any)?.name === 'AbortError';
        setDownloadFailed(!cancelled);
        setDownloadMessage(cancelled ? '已取消保存，服务器上的备份不受影响。' : `下载失败：${error instanceof Error ? error.message : '请检查网络后重试。'}`);
      }
    } finally {
      if (mounted.current && current === downloadId.current) {
        downloadBusy.current = false;
        setDownloading(false);
      }
    }
  };

  const title = loading ? '正在确认服务器状态…' : loadError ? '未连接 · 备份状态未确认' : status ? statusMessage(status) : '备份状态未确认';
  const unhealthy = Boolean(loadError || (status && (!status.enabled || !status.active || status.lastError || (status.lastSuccessAt && !status.verified))));
  const canDownload = !loading && !loadError && Boolean(status?.lastSuccessAt && status.verified);
  const hour = String(status?.hour ?? 2).padStart(2, '0');

  return <View className={styles.panel} aria-label='每日服务器备份'>
    <Text className={styles.heading}>每日服务器备份</Text>
    <Text className={styles.description}>业务提交成功后实时保存到服务器；每日备份是额外留一份副本，不需要手机一直开着。</Text>
    <View className={unhealthy ? styles.warning : styles.state} role='status' aria-live='polite' aria-atomic='true'>
      <Text className={styles.stateTitle}>{title}</Text>
      {loadError && <Text className={styles.detail}>{loadError} 当前不能确认已启用；手动导出和恢复仍可单独使用。</Text>}
      {!loading && status?.lastError && <Text className={styles.detail}>{status.lastError} 请保留现有备份并刷新确认重试结果。</Text>}
      {!loading && status && !status.enabled && <Text className={styles.detail}>需要在服务器启用定时任务，打开此页面不会自动启动备份。</Text>}
      {!loading && status?.enabled && !status.active && <Text className={styles.detail}>服务器已配置，但定时服务未运行，当前不会按计划生成新副本。</Text>}
    </View>
    <View className={styles.rows}>
      <View className={styles.row}><Text className={styles.label}>{status ? '每日计划' : '默认计划（未确认）'}</Text><Text className={styles.value}>北京时间 {hour}:00</Text></View>
      <View className={styles.row}><Text className={styles.label}>保留副本</Text><Text className={styles.value}>最近 {status?.keepDays ?? 30} 份 · 存在服务器</Text></View>
      <View className={styles.row}><Text className={styles.label}>最近成功</Text><Text className={styles.value}>{status ? formatDailyBackupTime(status.lastSuccessAt) : '待服务器确认'}</Text></View>
      {status?.lastAttemptAt && <View className={styles.row}><Text className={styles.label}>最近尝试</Text><Text className={styles.value}>{formatDailyBackupTime(status.lastAttemptAt)}</Text></View>}
      {status?.nextScheduledAt && <View className={styles.row}><Text className={styles.label}>下次计划</Text><Text className={styles.value}>{formatDailyBackupTime(status.nextScheduledAt)}</Text></View>}
      {status?.nextRetryAt && <View className={styles.row}><Text className={styles.label}>下次重试</Text><Text className={styles.value}>{formatDailyBackupTime(status.nextRetryAt)}</Text></View>}
    </View>
    <View className={styles.actions}>
      <Button className={styles.secondary} disabled={loading || downloading} onClick={() => void refresh()}>{loading ? '确认中…' : '刷新状态'}</Button>
      <Button className={styles.primary} disabled={!canDownload || downloading} onClick={() => void download()}>{downloading ? '正在下载…' : '下载最近备份'}</Button>
    </View>
    {!loading && !loadError && status && !canDownload && <Text className={styles.footnote}>还没有可确认的备份副本，下载按钮会在服务器完成备份并校验后开放。</Text>}
    <View className={downloadFailed ? styles.error : styles.footnote} role='status' aria-live='polite' aria-atomic='true'>{downloadMessage}</View>
  </View>;
}
