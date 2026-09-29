import React, { useState } from 'react';
import { View, Text, ScrollView, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { autoBestBase, getBaseUrl, setBaseUrl } from '@/services/request';
import { checkAndUpdate } from '@/services/update';
import styles from './index.module.scss';
import { getCopy } from '@/services/copy';
import { getStats } from '@/services/api';
import { session, watchSession, PUBLIC_ORIGIN, TEAM_ORIGIN } from '@/services/session';

const menus: { icon: IconName; text: string; desc: string; url: string; color: string; bg: string }[] = [
  { icon: 'clipboard', text: '库存查询', desc: '查看全部商品库存', url: '/pages/inventory/index', color: '#2f6bff', bg: '#eaf1ff' },
  { icon: 'mine', text: '客户管理', desc: '客户档案 / 出入库联动', url: '/pages/customers/index', color: '#0d9488', bg: '#e6f7f5' },
  { icon: 'mine', text: '供应商管理', desc: '往来资料 / 应付款', url: '/pages/suppliers/index', color: '#16a34a', bg: '#e6f7f5' },
  { icon: 'tag', text: '商品管理', desc: '新增 / 编辑 / 删除商品', url: '/pages/products/index', color: '#d97706', bg: '#fdf3e2' },
  { icon: 'records', text: '出入库记录', desc: '查看全部流水明细', url: '/pages/records/index', color: '#0891b2', bg: '#e5f7fa' },
  { icon: 'download', text: '备份与恢复', desc: '导出备份或恢复共享数据', url: '/pages/backup/index', color: '#2563eb', bg: '#eaf1ff' },
  { icon: 'records', text: '打印中心', desc: '打印当前出入库流水', url: '/pages/print-center/index', color: '#7c3aed', bg: '#f0eaff' },
  { icon: 'records', text: '账本流水', desc: '收入、支出与结清记录', url: '/pages/ledger/index', color: '#7c3aed', bg: '#f0eaff' },
  { icon: 'list', text: '客户订单', desc: '查看与管理客户订单', url: '/pages/orders/index', color: '#ea580c', bg: '#fff1e8' },
  { icon: 'box', text: '纸箱尺寸换算', desc: '内尺寸、外尺寸双向计算', url: '/pages/carton-calculator/index', color: '#0f766e', bg: '#e6f7f5' },
  { icon: 'edit', text: '自定义文案', desc: '修改页面菜单和按钮名称', url: '/pages/custom-copy/index', color: '#2563eb', bg: '#eaf1ff' }
];
const menuCopyKey = (url: string) => url.includes('inventory') ? 'inventory' : url.includes('customers') ? 'customers' : url.includes('suppliers') ? 'suppliers' : url.includes('products') ? 'products' : url.includes('records') ? 'records' : url.includes('ledger') ? 'ledger' : url.includes('orders') ? 'orders' : url.includes('carton-calculator') ? 'cartonCalculator' : '';

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
  const connectionRequest = React.useRef(0);
  const refreshConnection = React.useCallback(async () => {
    const request = ++connectionRequest.current;
    if (!session()) { setConnection('连接中'); return; }
    setConnection('检测中');
    try {
      await getStats();
      if (request === connectionRequest.current) setConnection('已连接');
    } catch (error) {
      if (request === connectionRequest.current) setConnection('连接异常');
    }
  }, []);
  useDidShow(() => { void refreshConnection(); });
  React.useEffect(() => {
    const unwatch = watchSession(() => { void refreshConnection(); });
    return () => { unwatch(); connectionRequest.current += 1; };
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

  const goTo = (url: string) => {
    Taro.navigateTo({ url });
  };


  // 连接测试：用输入框里的地址（未填则用当前生效地址）请求一次后端探活接口
  const testConn = async (url?: string) => {
    if (testing) return;
    setTesting(true);
    setTestResult('');
    try {
      const target = normalizeBase(url || addrVal || getBaseUrl());
      if (![PUBLIC_ORIGIN, TEAM_ORIGIN].includes(target)) throw new Error('地址必须是共享仓库服务器地址');
      const token = session()?.token;
      if (!token) throw new Error('仓库连接尚未建立，请稍后测试');
      const res: any = await Taro.request({
        url: `${target}/api/sync`,
        method: 'GET',
        header: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      const ok = res && res.statusCode >= 200 && res.statusCode < 300 && res.data?.success === true;
      if (target === getBaseUrl()) setConnection(ok ? '已连接' : '连接异常');
      setTestResult(ok
        ? '连接成功 ✓ 服务器可以正常访问'
        : '连接失败：服务器返回异常，请检查地址');
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
      // 用新地址做一次连通测试；失败仅提示，不阻断使用
      try {
        await getStats();
        setConnection('已连接');
      } catch (e) {
        setConnection('连接异常');
        Taro.showToast({ title: '已保存，但连接测试未通过', icon: 'none' });
      }
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
            <Text className={styles.heroSubtitle}>连接、更新与业务入口</Text>
          </View>
          <View className={`${styles.heroBadge} ${connection === '连接异常' ? styles.connectionError : ''}`} onClick={() => { void refreshConnection(); }}><View className={styles.liveDot} /><Text>{connection}</Text></View>
        </View>
        <View className={styles.connectionBar} onClick={() => setAddrOpen(true)}>
          <View className={styles.connectionIcon}><Icon name="trend" color="#2563eb" className={styles.connectionIconImg} /></View>
          <View className={styles.connectionCopy}><Text>当前服务节点</Text><Text>{addrSummary}</Text></View>
          <Text className={styles.connectionAction}>设置</Text>
        </View>
      </View>

      <View className={styles.sectionHead}><Text>业务入口</Text><Text>{menus.length} 项服务</Text></View>
      <View className={styles.menuGrid}>
        {menus.map(m => (
          <View key={m.url} className={styles.menuCard} onClick={() => goTo(m.url)}>
            <View className={styles.menuIcon} style={{ background: m.bg }}><Icon name={m.icon} color={m.color} className={styles.menuIconImg} /></View>
            <Text className={styles.menuText}>{getCopy(menuCopyKey(m.url) || m.text)}</Text>
            <Text className={styles.menuDesc}>{m.desc}</Text>
            <Icon name="chevron" color="#71809a" className={styles.menuArrow} />
          </View>
        ))}
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
