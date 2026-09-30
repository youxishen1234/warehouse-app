export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/board-stock/index',
    'pages/board-outbound/index',
    'pages/inbound/index',
    'pages/outbound/index',
    'pages/mine/index',
    'pages/inventory/index',
    'pages/products/index',
    'pages/records/index',
    'pages/ledger/index',
    'pages/orders/index',
    'pages/carton-calculator/index',
    'pages/board-calculator/index',
    'pages/team/index',
    'pages/suppliers/index',
    'pages/product-edit/index',
    'pages/customers/index',
    'pages/customer-edit/index'
    ,'pages/custom-copy/index'
    ,'pages/backup/index'
    ,'pages/print-center/index'
  ],
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '曙光库存',
    navigationBarTextStyle: 'black',
    navigationStyle: 'custom',
    backgroundColor: '#f5f6f8'
  },
  tabBar: {
    color: '#ffffff',
    selectedColor: '#24a6f8',
    backgroundColor: 'rgba(44, 44, 48, 0.68)',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/home/index',
        text: '首页',
        iconPath: 'assets/tabbar/home.svg',
        selectedIconPath: 'assets/tabbar/home-selected.svg'
      },
      {
        pagePath: 'pages/board-stock/index',
        text: '纸板',
        iconPath: 'assets/tabbar/inbound.svg',
        selectedIconPath: 'assets/tabbar/inbound-selected.svg'
      },
      {
        pagePath: 'pages/outbound/index',
        text: '出库',
        iconPath: 'assets/tabbar/outbound.svg',
        selectedIconPath: 'assets/tabbar/outbound-selected.svg'
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
