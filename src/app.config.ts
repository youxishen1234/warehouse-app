export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/customers/index',
    'pages/inventory/index',
    'pages/finance/index',
    'pages/suppliers/index',
    'pages/print-center/index'
  ],
  window: {
    backgroundTextStyle: 'dark',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '曙光库存',
    navigationBarTextStyle: 'black',
    navigationStyle: 'custom',
    backgroundColor: '#f4f7fc'
  }
})
