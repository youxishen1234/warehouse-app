(function () {
  const name = location.pathname.split('/').pop();
  const params = new URLSearchParams(location.search);
  let route = '/pages/home/index';
  if (name === 'print.html') route = '/pages/print-center/index';
  else if (name === 'customers.html') route = '/pages/customers/index';
  else if (name === 'management.html') {
    const views = { stock: '/pages/inventory/index', customers: '/pages/customers/index', suppliers: '/pages/suppliers/index', finance: '/pages/business-center/index?section=finance', ledger: '/pages/business-center/index?section=finance&view=ledger', records: '/pages/records/index', orders: '/pages/orders/index' };
    const actions = { 'board-in': '/pages/board-receive/index', 'carton-in': '/pages/inbound/index?kind=carton', 'stock-out': '/pages/outbound/index' };
    route = actions[params.get('action')] || views[params.get('view')] || route;
  }
  location.replace('./index.html#' + route);
})();
