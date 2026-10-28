import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { returnToBusinessHome } from '@/services/business-navigation';
import './style.scss';

export default function BusinessHeader({ title }: { title: string }) {
  return <View className='business-page-header' data-ui-version='web-workbench-v2'>
    <Button aria-label='返回总台' onClick={() => Taro.getCurrentPages().length > 1 ? void Taro.navigateBack() : void returnToBusinessHome()}>‹</Button>
    <View><Text className='business-page-caption'>曙光库存</Text><Text className='business-page-title'>{title}</Text></View>
    <Text className='business-page-date'>{new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</Text>
  </View>;
}
