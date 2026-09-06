import React, { useState } from 'react';
import { View, Text, ScrollView, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { autoBestBase, getBaseUrl, setBaseUrl } from '@/services/request';
import { checkAndUpdate } from '@/services/update';
import styles from './index.module.scss';

const menus: { icon: IconName; text: string; desc: string; url: string; color: string; bg: string }[] = [
  { icon: 'clipboard', text: '库存查询', desc: '查看全部商品库存', url: '/pages/inventory/index', color: '#2f6bff', bg: '#eaf1ff' },
  { icon: 'mine', text: '客户管理', desc: '客户档案 / 出入库联动', url: '/pages/customers/index', color: '#0d9488', bg: '#e6f7f5' },
  { icon: 'tag', text: '商品管理', desc: '新增 / 编辑 / 删除商品', url: '/pages/products/index', color: '#d97706', bg: '#fdf3e2' },
  { icon: 'records', text: '出入库记录', desc: '查看全部流水明细', url: '/pages/records/index', color: '#0891b2', bg: '#e5f7fa' }
];

const MineContent: React.FC = () => {
  const [addrOpen, setAddrOpen] = useState(false);
  const [addrVal, setAddrVal] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  const goAuto = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult('');
    try {
      const selected = await autoBestBase();
      setTestResult(selected ? '已自动选择：' + selected : '自动选择失败：暂时没有可用的服务器地址');
    } finally {
      setTesting(false);
    }
  };

  const goTo = (url: string) => {
    Taro.navigateTo({ url });
  };

  const openAddr = () => {
    setAddrVal(getBaseUrl());
    setTestResult('');
    setAddrOpen(true);
    testConn(getBaseUrl());
  };

  // 连接测试：用输入框里的地址（未填则用当前生效地址）请求一次后端探活接口
  const testConn = async (url?: string) => {
    if (testing) return;
    setTesting(true);
    setTestResult('');
    const target = normalizeBase(url || addrVal || getBaseUrl());
    try {
      const res: any = await Taro.request({
        url: `${target}/api/stats?page=1&pageSize=1`,
        method: 'GET',
        timeout: 10000
      });
      const ok = res && res.statusCode >= 200 && res.statusCode < 300;
      setTestResult(ok
        ? '连接成功 ✓ 服务器可以正常访问'
        : '连接失败：服务器返回异常，请检查地址');
    } catch (e) {
      setTestResult('连接失败 ✗ 请检查地址，或切换 Wi-Fi / 流量后再试');
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
        await Taro.request({ url: `${getBaseUrl()}/api/stats?page=1&pageSize=1`, timeout: 8000 });
      } catch (e) {
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
      window.location.href = 'http://152.136.100.200/download/';
    }
  };

  const copyIpaLink = () => {
    const link = getBaseUrl() + '/download/shuguang-ios.ipa';
    Taro.setClipboardData({
      data: link,
      success: () => Taro.showToast({ title: '安装包链接已复制', icon: 'success' }),
      fail: () => Taro.showToast({ title: '复制失败，请手动访问下载地址', icon: 'none' })
    });
  };

  const addrSummary = getBaseUrl().replace(/^https?:\/\//, '');
  const ipaSummary = addrSummary + '/download/shuguang-ios.ipa';

  const doCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const r = await checkAndUpdate();
      Taro.showToast({ title: r.message, icon: 'none' });
    } catch (e: any) {
      Taro.showToast({ title: e?.message || '检查更新失败', icon: 'none' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <View className={styles.header}>
        <View className={styles.avatar}>曙</View>
        <Text className={styles.headerTitle}>曙光库存</Text>
        <Text className={styles.headerDesc}>库存管理 · 清晰如一</Text>
      </View>

      <View className={styles.menuList}>
        {menus.map(m => (
          <View key={m.url} className={styles.menuItem} onClick={() => goTo(m.url)}>
            <View className={styles.menuIcon} style={{ background: m.bg }}>
              <Icon name={m.icon} color={m.color} className={styles.menuIconImg} />
            </View>
            <View className={styles.menuTextWrap}>
              <Text className={styles.menuText}>{m.text}</Text>
              <Text className={styles.menuDesc}>{m.desc}</Text>
            </View>
            <Icon name="chevron" color="#c0c6d0" className={styles.menuArrow} />
          </View>
        ))}
      </View>

      <Text className={styles.sectionTitle}>系统</Text>
      <View className={styles.menuList}>
        <View className={styles.menuItem} onClick={doCheck}>
          <View className={styles.menuIcon} style={{ background: 'rgba(8,145,178,0.14)' }}>
            <Icon name="trend" color="#0891b2" className={styles.menuIconImg} />
          </View>
          <View className={styles.menuTextWrap}>
            <Text className={styles.menuText}>检查更新</Text>
            <Text className={styles.menuDesc}>
              {checking ? '正在检查，发现新版本将自动更新…' : '发现新版本后自动下载并立即生效'}
            </Text>
          </View>
          <Icon name="chevron" color="#c0c6d0" className={styles.menuArrow} />
        </View>
        <View className={styles.menuItem} onClick={openUpdateAddress}>
          <View className={styles.menuIcon} style={{ background: 'rgba(99,102,241,0.14)' }}>
            <Icon name="edit" color="#6366f1" className={styles.menuIconImg} />
          </View>
          <View className={styles.menuTextWrap}>
            <Text className={styles.menuText}>服务器 / 更新地址</Text>
            <Text className={styles.menuDesc}>{addrSummary}</Text>
          </View>
          <Icon name="chevron" color="#c0c6d0" className={styles.menuArrow} />
        </View>
        <View className={styles.menuItem} onClick={copyIpaLink}>
          <View className={styles.menuIcon} style={{ background: 'rgba(47,107,255,0.14)' }}>
            <Icon name="download" color="#2f6bff" className={styles.menuIconImg} />
          </View>
          <View className={styles.menuTextWrap}>
            <Text className={styles.menuText}>App 安装包下载</Text>
            <Text className={styles.menuDesc}>{ipaSummary}</Text>
          </View>
          <Icon name="chevron" color="#c0c6d0" className={styles.menuArrow} />
        </View>
      </View>

      <View className={styles.about}>
        <Text>曙光 · 库存管理 v1.0</Text>
      </View>

      {addrOpen && (
        <View className={styles.mask} onClick={() => setAddrOpen(false)}>
          <View className={styles.addrDialog} onClick={(e) => e.stopPropagation()}>
            <Text className={styles.addrTitle}>服务器 / 更新地址</Text>
            <Text className={styles.addrTip}>
              连接不上服务器时，在这里修改后端地址即可（如隧道地址变化后）。留空并保存 = 恢复默认地址。
            </Text>
            <View className={styles.addrTestRow}>
                <View className={styles.addrTestBtn} onClick={() => testConn()}>
                  {testing ? '测试中…' : '测试连接'}
                </View>
                <View className={styles.addrAutoBtn} onClick={goAuto}>
                  {testing ? '连接中…' : '自动选择'}
                </View>
                {testResult ? (
                  <Text className={styles.addrTestResult}>
                    {testResult}
                  </Text>
                ) : null}
              </View>
            <Input
              className={styles.addrInput}
              value={addrVal}
              placeholder="http:// 或 https:// 开头的地址"
              placeholderClass={styles.addrPlaceholder}
              onInput={(e) => { setAddrVal(e.detail.value); setTestResult(''); }}
            />
            <View className={styles.addrBtns}>
              <View className={styles.addrBtnGhost} onClick={restoreDefault}>恢复默认</View>
              <View className={styles.addrBtnGhost} onClick={() => setAddrOpen(false)}>取消</View>
              <View className={styles.addrBtnPrimary} onClick={saveAddr}>
                {saving ? '保存中…' : '保存'}
              </View>
            </View>
          </View>
        </View>
      )}
    </ScrollView>
  );
};

export default MineContent;