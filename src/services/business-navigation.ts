import Taro from '@tarojs/taro';

const tabPages = new Set([
  '/pages/home/index', '/pages/ai-assistant/index', '/pages/inventory/index',
  '/pages/print-center/index', '/pages/mine/index'
]);

export function openBusinessPage(url: string) {
  return tabPages.has(url) ? Taro.switchTab({ url }) : Taro.navigateTo({ url });
}

export function returnToBusinessHome() {
  return Taro.switchTab({ url: '/pages/home/index' });
}
