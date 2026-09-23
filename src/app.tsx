import React, { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { isOffline, onOfflineChange, autoBestBase } from '@/services/request';
// 全局样式
import './app.scss';
import TeamAccess from '@/components/TeamAccess';
import { installTabNavigation } from '@/services/tab-navigation';

// 离线模式提示条：后端不可达且在使用本地缓存时展示，点击「重试」恢复在线
// 启动及离线期间每 15 秒自动在「局域网 → 隧道」候选地址间探测，
// 发现可达地址立即切换并自动消失
function OfflineBar() {
  const [offline, setOffline] = useState(isOffline());

  useEffect(() => {
    try { Taro.removeStorageSync('sg_api___offline'); } catch (e) { /* ignore */ }
    const off = onOfflineChange(setOffline);
    autoBestBase(); // 每次进入 App 自动探测：优先局域网，连不上走隧道
    const timer = setInterval(() => {
      if (isOffline()) {
        autoBestBase();
      }
    }, 15000);
    return () => { off(); clearInterval(timer); };
  }, []);

  if (!offline) return null;

  const retry = async () => {
    // 触发一次读接口探测连通性；成功后 setOffline(false) 会自动隐藏
    try {
      await import('@/services/api').then(m => m.getStats());
    } catch (e) { /* 仍离线，保持展示 */ }
  };

  return (
    <View className='sg-offline-bar'>
      <Text className='sg-offline-bar-text'>离线模式 · 展示本地缓存数据</Text>
      <Text className='sg-offline-retry' onClick={retry}>重试</Text>
    </View>
  );
}

function TabSwipeNavigator() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    return installTabNavigation({
      route: () => {
        const page = Taro.getCurrentPages().slice(-1)[0];
        return page?.route || location.hash.slice(1) || '/pages/home/index';
      },
      switchTab: url => Taro.switchTab({ url }),
      back: () => Taro.navigateBack({ delta: 1 }),
      depth: () => Taro.getCurrentPages().length
    });
  }, []);
  return null;
}

function App(props) {
  // 可以使用所有的 React Hooks
  useEffect(() => {});

  return (
    <TeamAccess>
      {props.children}
      <TabSwipeNavigator />
      <OfflineBar />
    </TeamAccess>
  );
}

export default App;
