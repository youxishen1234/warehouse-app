import React, { useState } from 'react';
import { View, Text, ScrollView, Input, Button } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '@/components/Icon';

import { autoBestBase, checkServerHealth, getBaseUrl, setBaseUrl } from '@/services/request';
import { checkAndUpdate } from '@/services/update';
import { WEB_DISPLAY_VERSION } from '@/config/release';
import styles from './index.module.scss';

import { PUBLIC_ORIGIN, TEAM_ORIGIN, session, watchSession } from '@/services/session';

const DOWNLOAD_PAGE_URL = 'https://youxishen.online/download/';
const IPA_URL = 'https://youxishen.online/shuguang.ipa';
const IPA_METADATA_URL = `${DOWNLOAD_PAGE_URL}ipa.json`;

const MineContent: React.FC = () => {
  const [currentSession, setCurrentSession] = useState(session);
  React.useEffect(() => watchSession(() => setCurrentSession(session())), []);
  const userName = currentSession?.user?.username || '我的账户';
  const roleName = currentSession?.user?.role === 'admin' ? '管理员' : currentSession?.user?.role === 'operator' ? '操作员' : currentSession?.user?.role === 'viewer' ? '查看员' : '尚未登录';
  const openPage = (url: string) => void Taro.navigateTo({ url });
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
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [ipaDirectUrl, setIpaDirectUrl] = useState(IPA_URL);
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
      if (!win.__sgNativeDock?.version && current?.native) setNativeVersion(current.native);
    }).catch(() => undefined);
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

  const openExternal = (url: string) => {
    if (typeof window === 'undefined') return;
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) window.location.assign(url);
  };

  const openUpdateAddress = () => openExternal(DOWNLOAD_PAGE_URL);

  const openInstallHelp = () => {
    setInstallHelpOpen(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    fetch(IPA_METADATA_URL, { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then((metadata: any) => {
        const path = typeof metadata?.url === 'string' ? metadata.url : '';
        if (/^\/download\/[A-Za-z0-9._-]+\.ipa$/.test(path)) {
          setIpaDirectUrl(`https://youxishen.online${path}`);
        }
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  };

  const addrSummary = getBaseUrl().replace(/^https?:\/\//, '');

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
      <View className={styles.pageHeader}>
        <View><Text className={styles.pageEyebrow}>曙 光 库 存</Text><Text className={styles.pageTitle}>我的</Text></View>
        <View className={styles.headerMark}><Icon name='mine' color='#2469ee' className={styles.headerIcon} /></View>
      </View>
      <View className={styles.content}>
      <View className={styles.hero}>
        <View className={styles.heroTop}>
          <View className={styles.brandMark}><Icon name='mine' color='#2469ee' className={styles.avatarIcon} /></View>
          <View className={styles.heroCopy}>
            <Text className={styles.heroTitle}>{userName}</Text>
            <Text className={styles.heroSubtitle}>{roleName} · 共享仓库</Text>
          </View>
          <Button aria-label='刷新连接状态' className={`${styles.heroBadge} ${connectionDetail ? styles.connectionError : ''}`} onClick={() => { void refreshConnection(); }}><View className={styles.liveDot} /><Text>{connection}</Text></Button>
        </View>
        {connectionDetail && <Text className={styles.connectionDetail}>{connectionDetail}</Text>}
        <View className={styles.profileFoot}><Text>我的工作空间</Text><Text>曙光库存</Text></View>
      </View>

      <View className={styles.sectionHead}><Text>仓库管理</Text><Text>WORKSPACE</Text></View>
      <View className={styles.menuGrid}>
        <Button className={styles.menuCard} onClick={() => openPage('/pages/management/index?section=team')}>
          <View className={`${styles.menuIcon} ${styles.blue}`}><Icon name='mine' color='#2469ee' className={styles.menuIconImg} /></View>
          <Text className={styles.menuText}>团队管理</Text><Text className={styles.menuDesc}>成员与访问权限</Text>
          <Icon name='chevron' color='#b2bfd0' className={styles.menuArrow} />
        </Button>
        <Button className={styles.menuCard} onClick={() => openPage('/pages/management/index?section=backup')}>
          <View className={`${styles.menuIcon} ${styles.cyan}`}><Icon name='box' color='#3a987d' className={styles.menuIconImg} /></View>
          <Text className={styles.menuText}>数据备份</Text><Text className={styles.menuDesc}>备份与恢复记录</Text>
          <Icon name='chevron' color='#b2bfd0' className={styles.menuArrow} />
        </Button>
      </View>

      <View className={styles.sectionHead}><Text>系统设置</Text><Text>SETTINGS</Text></View>
      <View className={styles.systemStack}>
        <Button className={styles.systemCard} onClick={doCheck} disabled={checking || ipaDownloading}>
          <View className={`${styles.systemIcon} ${styles.blue}`}><Icon name="trend" color="#2469ee" className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>检查更新</Text><Text>{checking ? '正在检查版本…' : `当前版本 ${WEB_DISPLAY_VERSION}`}</Text></View>
          <Text className={styles.versionTag}>{checking ? '检查中' : '检查'}</Text><Icon name='chevron' color='#b2bfd0' className={styles.rowArrow} />
        </Button>
        <Button className={styles.systemCard} onClick={() => setAddrOpen(true)}>
          <View className={`${styles.systemIcon} ${styles.purple}`}><Icon name="edit" color="#8a79b6" className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>连接设置</Text><Text>{addrSummary}</Text></View>
          <Icon name='chevron' color='#b2bfd0' className={styles.rowArrow} />
        </Button>
        <Button className={styles.systemCard} onClick={openInstallHelp}>
          <View className={`${styles.systemIcon} ${styles.cyan}`}><Icon name="download" color="#3a987d" className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>下载安装包</Text><Text>iOS App 安装与升级</Text></View>
          <Icon name='chevron' color='#b2bfd0' className={styles.rowArrow} />
        </Button>
        <Button className={styles.systemCard} onClick={openUpdateAddress}>
          <View className={`${styles.systemIcon} ${styles.slate}`}><Icon name='home' color='#73849d' className={styles.systemIconImg} /></View>
          <View className={styles.systemCopy}><Text>官方网站</Text><Text>应用下载与版本信息</Text></View>
          <Icon name='chevron' color='#b2bfd0' className={styles.rowArrow} />
        </Button>
      </View>

      <View className={styles.footerInfo}><View className={styles.footerBrand}>曙</View><Text>曙光库存 · 让每一笔业务井然有序</Text><Text>{nativeVersion || 'Web 控制台'}</Text></View>
      </View>

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

      {installHelpOpen && (
        <View className={styles.mask} onClick={() => setInstallHelpOpen(false)}>
          <View className={styles.ipaDialog} onClick={e => e.stopPropagation()}>
            <View className={styles.ipaTitleRow}><View className={styles.ipaIcon}><Icon name="download" color="#fff" className={styles.ipaIconImg} /></View><Text className={styles.ipaTitle}>安装包下载</Text></View>
            <Text className={styles.ipaStatus}>下载 IPA 文件后，需要使用与手机匹配的开发者证书签名安装。已经安装的 App，网页功能更新请使用“检查更新”。</Text>
            <View className={styles.ipaActions}>
              <Button className={styles.ipaPrimaryBtn} onClick={() => openExternal(DOWNLOAD_PAGE_URL)}>打开下载页</Button>
              <Button className={styles.ipaSecondaryBtn} onClick={() => openExternal(ipaDirectUrl)}>直接下载 IPA</Button>
              <Button className={styles.ipaTextBtn} onClick={() => setInstallHelpOpen(false)}>关闭</Button>
            </View>
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
