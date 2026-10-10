import React, { useState } from 'react';
import { View, Text, ScrollView, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '@/components/Icon';

import { autoBestBase, checkServerHealth, getBaseUrl, setBaseUrl } from '@/services/request';
import { checkAndUpdate } from '@/services/update';
import styles from './index.module.scss';

import { PUBLIC_ORIGIN, TEAM_ORIGIN } from '@/services/session';

const MineContent: React.FC = () => {
  const [addrOpen, setAddrOpen] = useState(false);
  const [addrVal, setAddrVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [ipaDownloading, setIpaDownloading] = useState(false);
  const [ipaProgress, setIpaProgress] = useState(0);
  const [ipaMessage, setIpaMessage] = useState('正在下载新版 IPA');
  const [ipaCompleted, setIpaCompleted] = useState(false);
  const [webVersion, setWebVersion] = useState('获取中…');
  const [nativeVersion, setNativeVersion] = useState('');
  const [connection, setConnection] = useState('检测中');
  const [updateKind, setUpdateKind] = useState<'web' | 'ipa'>('web');
  const [connectionDetail, setConnectionDetail] = useState('');
  const connectionRequest = React.useRef(0);
  const connectionPending = React.useRef<Promise<boolean> | null>(null);
  const refreshConnection = React.useCallback((): Promise<boolean> => {
    if (connectionPending.current) return connectionPending.current;
    const request = ++connectionRequest.current;
    setConnection('检测中');
    setConnectionDetail('');
    const work = checkServerHealth().then(() => {
      if (request === connectionRequest.current) setConnection('已连接');
      return true;
    }).catch((error) => {
      if (request === connectionRequest.current) {
        const message = String(error?.message || '');
        setConnection(message.includes('超时') ? '连接超时' : message.includes('网络未连接') ? '网络未连接' : '连接异常');
        setConnectionDetail(/^(连接超时|网络未连接|服务器)/.test(message) ? message : '无法连接服务器，请检查网络后点击状态重试');
      }
      return false;
    }).finally(() => {
      if (request === connectionRequest.current) connectionPending.current = null;
    });
    connectionPending.current = work;
    return work;
  }, []);
  useDidShow(() => { void refreshConnection(); });
  React.useEffect(() => {
    const onOnline = () => { void refreshConnection(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshConnection(); };
    void refreshConnection();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      connectionRequest.current += 1;
      connectionPending.current = null;
    };
  }, [refreshConnection]);
  React.useEffect(() => {
    const win = window as any;
    const refresh = () => {
      const info = win.__sgNativeDock;
      if (info?.version) setNativeVersion(`${info.version} (Build ${info.build})`);
    };
    refresh();
    window.addEventListener('sg-native-ready', refresh);
    const updater = win.Capacitor?.Plugins?.CapacitorUpdater;
    if (updater) updater.current().then((current: any) => {
      setWebVersion(current?.bundle?.version || 'builtin');
      if (!win.__sgNativeDock?.version && current?.native) setNativeVersion(current.native);
    }).catch(() => setWebVersion('未知'));
    else setWebVersion('浏览器');
    return () => window.removeEventListener('sg-native-ready', refresh);
  }, []);

  const goAuto = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult('');
    try {
      const selected = await autoBestBase();
      setTestResult(selected ? '已自动选择：' + selected : '自动选择失败：暂时没有可用的服务器地址');
      void refreshConnection();
    } finally {
      setTesting(false);
    }
  };

  // 连接测试：用输入框里的地址（未填则用当前生效地址）请求一次后端探活接口
  const testConn = async (url?: string) => {
    if (testing) return;
    setTesting(true);
    setTestResult('');
    try {
      const target = normalizeBase(url || addrVal || getBaseUrl());
      if (![PUBLIC_ORIGIN, TEAM_ORIGIN].includes(target)) throw new Error('地址必须是共享仓库服务器地址');
      await checkServerHealth(target);
      setTestResult('连接成功 ✓ 服务器可以正常访问');
      if (target === getBaseUrl()) void refreshConnection();
    } catch (e: any) {
      setTestResult(e?.message || e?.errMsg || '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  // 去掉末尾斜杠，保证拼接正确
  const normalizeBase = (url: string) => url.trim().replace(/\/+$/, '');

  const restoreDefault = () => {
    setAddrVal('');
    Taro.showToast({ title: '已恢复默认地址，点保存生效', icon: 'none' });
  };

  const saveAddr = async () => {
    setSaving(true);
    try {
      setBaseUrl(addrVal);
      setAddrOpen(false);
      Taro.showToast({ title: '地址已保存', icon: 'success' });
      connectionRequest.current += 1;
      connectionPending.current = null;
      if (!await refreshConnection()) Taro.showToast({ title: '已保存，但连接测试未通过', icon: 'none' });
    } catch (e: any) {
      Taro.showToast({ title: e?.message || '地址格式不正确', icon: 'none' });
    } finally {
      setSaving(false);
    }
  };

  const openUpdateAddress = () => {
    if (typeof window !== 'undefined') {
      window.open('https://youxishen.online/download/', '_blank', 'noopener');
    }
  };

  const downloadIpa = async () => {
    if (ipaDownloading) return;
    setUpdateKind('ipa');
    setIpaDownloading(true);
    setIpaCompleted(false);
    setIpaMessage('正在下载新版 IPA');
    setIpaProgress(0);
    try {
      const task = Taro.downloadFile({
        url: `https://youxishen.online/shuguang.ipa?t=${Date.now()}`,
        timeout: 10 * 60 * 1000
      });
      task.onProgressUpdate((res) => {
        setIpaProgress(Math.max(0, Math.min(100, res.progress || 0)));
      });
      const result = await task;
      if (result.statusCode < 200 || result.statusCode >= 300) {
        throw new Error(`HTTP ${result.statusCode}`);
      }
      setIpaProgress(100);
      setIpaMessage('IPA 已下载，需要签名安装；重启 App 不会安装 IPA');
      setIpaCompleted(true);
    } catch (e: any) {
      setIpaMessage(e?.message || '下载失败，请重试');
      setIpaCompleted(true);
    }
  };

  const addrSummary = getBaseUrl().replace(/^https?:\/\//, '');
  const ipaSummary = 'youxishen.online/shuguang.ipa';

  const doCheck = async () => {
    if (checking || ipaDownloading) return;
    setUpdateKind('web');
    setChecking(true);
    setIpaCompleted(false);
    setIpaMessage('正在检查更新');
    setIpaProgress(0);
    setIpaDownloading(true);
    try {
      const r = await checkAndUpdate();
      if (r.hasUpdate && r.message.includes('已下载')) {
        setIpaProgress(100);
        setIpaMessage('更新已下载，请关闭后重新打开 App 生效');
        setIpaCompleted(true);
      } else {
        setIpaDownloading(false);
        Taro.showToast({ title: r.message, icon: 'none' });
      }
    } catch (e: any) {
      setIpaMessage(e?.message || '检查更新失败');
      setIpaCompleted(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <View className={styles.hero}>
        <View className={styles.heroTop}>
          <View className={styles.brandMark}>曙</View>
          <View className={styles.heroCopy}>
            <Text className={styles.eyebrow}>SHUGUANG / WORKSPACE</Text>
            <Text className={styles.heroTitle}>我的工作台</Text>
            <Text className={styles.heroSubtitle}>连接与更新设置</Text>
          </View>
          <View className={`${styles.heroBadge} ${connectionDetail ? styles.connectionError : ''}`} onClick={() => { void refreshConnection(); }}><View className={styles.liveDot} /><Text>{connection}</Text></View>
        </View>
        {connectionDetail && <Text className={styles.connectionDetail}>{connectionDetail}</Text>}
        <View className={styles.connectionBar} onClick={() => setAddrOpen(true)}>
          <View className={styles.connectionIcon}><Icon name="trend" color="#2563eb" className={styles.connectionIconImg} /></View>
          <View className={styles.connectionCopy}><Text>当前服务节点</Text><Text>{addrSummary}</Text></View>
          <Text className={styles.connectionAction}>设置</Text>
        </View>
      </View>

      <View className={styles.sectionHead}><Text>系统与连接</Text><Text>设备设置</Text></View>
      <View className={styles.systemStack}>
        <View className={styles.systemCard} onClick={doCheck}>
          <View className={`${styles.systemIcon} ${styles.cyan}`}><Icon name="trend" color="#0f766e" className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>检查更新</Text><Text>{checking ? '正在检查版本…' : `网页版本 ${webVersion}`}</Text></View>
          <Text className={styles.systemAction}>{checking ? '检查中' : '检查'}</Text>
        </View>
        <View className={styles.systemCard} onClick={() => setAddrOpen(true)}>
          <View className={`${styles.systemIcon} ${styles.purple}`}><Icon name="edit" color="#7c3aed" className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>服务器 / 更新地址</Text><Text>{addrSummary}</Text></View>
          <View className={styles.systemActions}><Text onClick={(e) => { e.stopPropagation(); openUpdateAddress(); }}>官网</Text><Text>设置</Text></View>
        </View>
        <View className={styles.systemCard} onClick={downloadIpa}>
          <View className={`${styles.systemIcon} ${styles.blue}`}><Icon name="download" color="#2563eb" className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>App 安装包下载</Text><Text>{ipaSummary}</Text></View>
          <Text className={styles.systemAction}>下载</Text>
        </View>
      </View>

      <View className={styles.footerInfo}><Text>曙光库存 · 共享仓库</Text><Text>{nativeVersion ? nativeVersion : 'Web 控制台'}</Text></View>

      {ipaDownloading && (
        <View className={styles.mask}>
          <View className={styles.ipaDialog}>
            <View className={styles.ipaTitleRow}><View className={styles.ipaIcon}><Icon name="download" color="#fff" className={styles.ipaIconImg} /></View><Text className={styles.ipaTitle}>{updateKind === 'ipa' ? '安装包下载' : '网页更新'}</Text></View>
            <View className={styles.ipaFileName}>{updateKind === 'ipa' ? 'shuguang.ipa' : 'www.zip'}</View><Text className={styles.ipaStatus}>{ipaMessage}</Text>
            {!ipaCompleted && <View className={styles.ipaProgressTrack}><View className={styles.ipaProgressBar} style={{ width: `${ipaProgress}%` }} /></View>}
            {!ipaCompleted && <Text className={styles.ipaProgressText}>{ipaProgress}%</Text>}
            {ipaCompleted && <View className={styles.ipaCloseBtn} onClick={() => setIpaDownloading(false)}>关闭</View>}
          </View>
        </View>
      )}

      {addrOpen && (
        <View className={styles.mask} onClick={() => setAddrOpen(false)}>
          <View className={styles.addrDialog} onClick={e => e.stopPropagation()}>
            <Text className={styles.addrTitle}>服务器 / 更新地址</Text>
            <Text className={styles.addrTip}>连接不上服务器时可在这里修改。留空并保存会恢复默认地址。</Text>
            <View className={styles.addrTestRow}><View className={styles.addrTestBtn} onClick={() => testConn()}>{testing ? '测试中…' : '测试连接'}</View><View className={styles.addrAutoBtn} onClick={goAuto}>{testing ? '连接中…' : '自动选择'}</View>{testResult ? <Text className={styles.addrTestResult}>{testResult}</Text> : null}</View>
            <Input className={styles.addrInput} value={addrVal} placeholder="http:// 或 https:// 开头的地址" placeholderClass={styles.addrPlaceholder} onInput={e => { setAddrVal(e.detail.value); setTestResult(''); }} />
            <View className={styles.addrBtns}><View className={styles.addrBtnGhost} onClick={restoreDefault}>恢复默认</View><View className={styles.addrBtnGhost} onClick={() => setAddrOpen(false)}>取消</View><View className={styles.addrBtnPrimary} onClick={saveAddr}>{saving ? '保存中…' : '保存'}</View></View>
          </View>
        </View>
      )}
    </ScrollView>
  );
};

export default MineContent;
