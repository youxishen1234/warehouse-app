export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/ai-assistant/index',
    'pages/management/index',
    'pages/mine/index',
    'pages/inventory/index',
    'pages/customers/index',
    'pages/print-center/index'
  ],
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '曙光库存',
    navigationBarTextStyle: 'black',
    navigationStyle: 'custom',
    backgroundColor: '#f4f7fc'
  },
  tabBar: {
    color: '#96a3b6',
    selectedColor: '#2469ee',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/home/index',
        text: '总台',
        iconPath: 'assets/tabbar/home.svg',
        selectedIconPath: 'assets/tabbar/home-selected.svg'
      },
      {
        pagePath: 'pages/ai-assistant/index',
        text: 'AI助手',
        iconPath: 'assets/tabbar/ai.svg',
        selectedIconPath: 'assets/tabbar/ai-selected.svg'
      },
      {
        pagePath: 'pages/inventory/index',
        text: '库存',
        iconPath: 'assets/tabbar/inbound.svg',
        selectedIconPath: 'assets/tabbar/inbound-selected.svg'
      },
      {
        pagePath: 'pages/print-center/index',
        text: '打印',
        iconPath: 'assets/tabbar/printer.svg',
        selectedIconPath: 'assets/tabbar/printer-selected.svg'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.svg',
        selectedIconPath: 'assets/tabbar/mine-selected.svg'
      }
    ]
  }
})
