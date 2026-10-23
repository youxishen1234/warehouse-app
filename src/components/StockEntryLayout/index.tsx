import { ReactNode, useEffect, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '@/components/Icon';
import './style.scss';

type Props = { title: string; subtitle?: string; children: ReactNode; onRefresh?: () => void; busy?: boolean; back?: boolean };

export default function StockEntryLayout({ title, subtitle, children, onRefresh, busy = false, back = true }: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(timer); }, []);
  const goBack = () => {
    if (busy) return;
    if (Taro.getCurrentPages().length > 1) void Taro.navigateBack();
    else void Taro.navigateTo({ url: '/pages/business-center/index' });
  };
  return <View className='stock-entry-page' data-testid='stock-entry-page'>
    <View className='stock-entry-surface'>
      <View className='stock-entry-header'>
        <View className='stock-entry-heading'>
          {back && <Button className='stock-entry-back' aria-label='返回' disabled={busy} onClick={goBack}>‹</Button>}
          <View className='stock-entry-mark'><Icon name={title.includes('出库') ? 'truck' : 'package-plus'} color='#222924' style={{ width: 20, height: 20 }} /></View>
          <Text className='stock-entry-heading-title'>{title}</Text>
          {onRefresh && <Button className='stock-entry-refresh' disabled={busy} onClick={onRefresh}>刷新</Button>}
        </View>
        <View className='stock-entry-date'><Text>{now.getFullYear()}年{now.getMonth() + 1}月{now.getDate()}日 · 周{'日一二三四五六'[now.getDay()]}</Text><Text>{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</Text></View>
        {subtitle && <Text className='stock-entry-subtitle'>{subtitle}</Text>}
      </View>
      <View className='stock-entry-content'>{children}</View>
    </View>
  </View>;
}
