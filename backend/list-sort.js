// Only explicit business fields can control ordering; never evaluate query input.
const SORT_FIELDS = {
  products: { id: 'number', name: 'text', specification: 'text', material: 'text', unit: 'text', price: 'number', stock: 'number', safety_stock: 'number', created_at: 'number', profile_updated_at: 'number', stock_updated_at: 'number' },
  customers: { id: 'number', name: 'text', contact: 'text', phone: 'text', debt: 'number', created_at: 'number', profile_updated_at: 'number', balance_updated_at: 'number' },
  suppliers: { id: 'number', name: 'text', contact: 'text', phone: 'text', payable: 'number', created_at: 'number', profile_updated_at: 'number', balance_updated_at: 'number' },
  orders: { id: 'number', order_no: 'text', customer_name: 'text', quantity: 'number', unit_price: 'number', amount: 'number', status: 'text', delivery_date: 'text', created_at: 'number' },
  transactions: { id: 'number', created_at: 'number', type: 'text', quantity: 'number', unit_price: 'number', amount: 'number', product_name: 'text', customer_name: 'text', supplier_name: 'text' },
  ledger: { id: 'number', created_at: 'number', type: 'text', amount: 'number', party_name: 'text' },
  stocktakes: { id: 'number', created_at: 'number', counted_at: 'number', before_stock: 'number', counted_stock: 'number', diff: 'number' },
  delivery_notes: { id: 'number', created_at: 'number', date: 'text', work_order_no: 'text', freight: 'number', total_amount: 'number', total_square_meters: 'number' },
  order_events: { id: 'number', created_at: 'number', from: 'text', to: 'text' }
};
const DEFAULT_SORT = { products: 'profile_updated_at', customers: 'profile_updated_at', suppliers: 'profile_updated_at' };
const ORDER_STATUSES = Object.freeze(['待生产', '生产中', '已发货', '已完成', '已取消']);

function validateSortQuery(query, collection) {
  const fields = SORT_FIELDS[collection];
  if (query.sort !== undefined && (!fields || !Object.prototype.hasOwnProperty.call(fields, query.sort))) {
    throw Object.assign(new Error(`排序字段无效，允许值：${Object.keys(fields || {}).join('、')}`), { status: 400 });
  }
  if (query.order !== undefined && !['asc', 'desc'].includes(query.order)) {
    throw Object.assign(new Error('排序方向无效，允许值：asc、desc'), { status: 400 });
  }
}

function sortList(rows, query, collection) {
  if (query.sort === undefined && query.order === undefined) return rows;
  const field = query.sort || DEFAULT_SORT[collection] || 'created_at';
  const kind = SORT_FIELDS[collection][field];
  const direction = query.order === 'asc' ? 1 : -1;
  const value = row => {
    const raw = row[field] ?? (field === 'profile_updated_at' ? row.updated_at ?? row.created_at : undefined);
    return kind === 'number' ? (raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw)) : (raw == null || raw === '' ? null : String(raw));
  };
  return rows.slice().sort((left, right) => {
    const a = value(left), b = value(right);
    // Missing optional values sort last in either direction.
    if (a === null && b !== null) return 1;
    if (b === null && a !== null) return -1;
    const difference = a === null ? 0 : kind === 'number' ? a - b : a.localeCompare(b, 'zh-CN');
    return direction * (difference || Number(left.id) - Number(right.id));
  });
}

module.exports = { ORDER_STATUSES, SORT_FIELDS, validateSortQuery, sortList };
