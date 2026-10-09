import { View } from '@tarojs/components';
import { useDidShow } from '@tarojs/taro';
import { standalonePageUrl } from '@/services/standalone-page';

export default function CustomerDeskPage() {
  useDidShow(() => {
    if (typeof window !== 'undefined') window.location.replace(standalonePageUrl('customer-desk.html').href);
  });
  return <View>正在打开客户尺寸本…</View>;
}
