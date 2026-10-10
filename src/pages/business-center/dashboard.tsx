import { useMemo, useRef, useState } from 'react';
import { View, Text, Input, Button, Picker } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { getCustomers, getOrders, getProducts, getTransactions, stockIn, updateOrder } from '@/services/api';
import { boardSpec, cartonSpec, getBoards } from '@/services/boards';
import { getCustomerDimensions, orderFromDimension, saveCustomerDimensions } from '@/services/customer-dimensions';
import type { DimensionDocument, DimensionSpec } from '@/services/customer-dimensions';
import type { CustomerOrder, Product } from '@/types';
import { useRemoteData } from '@/hooks/useRemoteData';
import { useSharedRefresh } from '@/services/shared-refresh';
import { session } from '@/services/session';
import { invalidateProducts } from '@/services/product-store';
import { formatMoney, formatShortTime } from '@/utils/format';
import { numberValue } from '@/utils/stock-math';
import { OutboundDocument } from '@/pages/outbound/document';
import { boardMatches, customerMatches, groupBoards, groupShipments, matchingProducts, matchesQuery, mergeCustomers, remainingOrder, specMatches } from './model';
import type { BusinessCustomer } from './model';
import styles from './index.module.scss';

type Field = { key: string; label: string; value: string; options?: string[]; numeric?: boolean; required?: boolean };
type Editor = { title: string; fields: Field[]; submit: (values: Record<string, string>) => Promise<void>; hint?: string };
type Filter = 'all' | 'boards' | 'customers' | 'orders';
const freshId = () => 'dimension-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const open = (url: string) => void Taro.navigateTo({ url });
const emptyDocument: DimensionDocument = { schemaVersion: 1, revision: 0, customers: [], theme: { title: '客户尺寸本', accent: '#468cfb', bg: '#101319', card: '#202630' } };
const loadBusiness = async () => {
  const [boards, dimensions, customers, products, orders, transactions] = await Promise.all([
    getBoards(), getCustomerDimensions(), getCustomers(), getProducts(), getOrders(), getTransactions({ type: 'out' })
  ]);
  if (!dimensions || !Array.isArray(dimensions.customers) || ![boards, customers, products, orders, transactions].every(Array.isArray)) throw new Error('业务资料格式异常，请刷新重试');
  return { boards, dimensions, customers, products, orders, transactions };
};

export default function BusinessDashboard() {
  const remote = useRemoteData(loadBusiness, { boards: [], dimensions: emptyDocument, customers: [], products: [], orders: [], transactions: [] } as Awaited<ReturnType<typeof loadBusiness>>);
  const { data, reload } = remote;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof getTransactions>>>([]);
  const lock = useRef(false);
  const shown = useRef(false);
  const writable = !!session() && session()?.user.role !== 'viewer';
  useSharedRefresh(reload);
  useDidShow(() => { if (shown.current) void reload(); shown.current = true; });
  const boards = useMemo(() => groupBoards(data.boards), [data.boards]);
  const customers = useMemo(() => mergeCustomers(data.dimensions.customers, data.customers), [data.dimensions, data.customers]);
  const shipments = useMemo(() => groupShipments(data.transactions), [data.transactions]);
  const visibleBoards = boards.filter(group => boardMatches(query, group.batches));
  const visibleCustomers = customers.filter(c => customerMatches(query, c));
  const visibleOrders = data.orders.filter(o => matchesQuery(query, [o.order_no, o.customer_name, o.specification, o.material, o.remark, o.status]));
  const visibleShipments = shipments.filter(note => note.rows.some(tx => matchesQuery(query, [note.no, tx.customer_name, tx.order_no, tx.specification, tx.product_name, tx.material, tx.remark])));
  const toggle = (key: string) => setCollapsed(state => ({ ...state, [key]: !state[key] }));
  const toggleRow = (key: string) => setExpanded(state => ({ ...state, [key]: !state[key] }));
  const hasSection = (key: Filter) => filter === 'all' || filter === key;
  const startEditor = (next: Editor) => { setValues(Object.fromEntries(next.fields.map(f => [f.key, f.value]))); setFormError(''); setEditor(next); };
  const editCompany = (customer?: BusinessCustomer) => {
    const original = data.dimensions;
    const newId = freshId();
    startEditor({ title: customer ? '修改公司名称' : '新增客户', fields: [{ key: 'name', label: '公司名称', value: customer?.name || '', required: true }], submit: async v => {
      const snapshot: DimensionDocument = JSON.parse(JSON.stringify(original));
      const target = snapshot.customers.find(c => c.id === customer?.dimension?.id);
      if (snapshot.customers.some(c => c !== target && c.name === v.name)) throw new Error('已有同名公司，请直接添加规格');
      if (target) target.name = v.name;
      else snapshot.customers.push({ id: newId, name: v.name, specs: [] });
      await saveCustomerDimensions(snapshot);
    } });
  };
  const editSpec = (customer: BusinessCustomer, spec?: DimensionSpec) => {
    const original = data.dimensions;
    const companyId = freshId(), specId = freshId();
    startEditor({ title: spec ? '修改规格' : '添加常用规格', fields: [
      { key: 'goods', label: '货物名称（选填）', value: spec?.goods || '' },
      { key: 'size', label: '规格尺寸', value: spec?.size || '', required: true },
      { key: 'sizeUnit', label: '尺寸单位', value: spec?.sizeUnit || 'cm', options: ['cm', 'mm'] },
      { key: 'kind', label: '类别', value: spec?.kind || '成品', options: ['成品', '纸板'] },
      { key: 'material', label: '材质（选填）', value: spec?.material || '' },
      { key: 'unit', label: '数量单位', value: spec?.unit || '个', options: ['个', '张', '件', '套'] }
    ], submit: async v => {
      const snapshot: DimensionDocument = JSON.parse(JSON.stringify(original));
      let company = snapshot.customers.find(c => c.id === customer.dimension?.id);
      if (!company) { company = { id: companyId, name: customer.name, specs: [] }; snapshot.customers.push(company); }
      const next: DimensionSpec = { id: spec?.id || specId, goods: v.goods, size: v.size, sizeUnit: v.sizeUnit, material: v.material, unit: v.unit, kind: v.kind as DimensionSpec['kind'] };
      if (spec) company.specs = company.specs.map(s => s.id === spec.id ? next : s);
      else company.specs.push(next);
      await saveCustomerDimensions(snapshot);
    } });
  };
  const createOrder = (customer: BusinessCustomer, spec: DimensionSpec) => startEditor({
    title: '开单 · ' + customer.name, hint: '开单后到出库页核对商品和数量，确认出库才扣减库存。', fields: [
      { key: 'quantity', label: '数量（' + spec.unit + '）', value: '', numeric: true, required: true },
      { key: 'price', label: '单价（元）', value: '0', numeric: true, required: true }
    ], submit: async v => {
      const quantity = numberValue(v.quantity, '数量', true);
      if (!Number.isSafeInteger(quantity)) throw new Error('数量必须为正整数');
      const unitPrice = numberValue(v.price, '单价');
      await orderFromDimension({ customer_id: customer.dimension!.id, spec_id: spec.id, quantity, unit_price: unitPrice });
    }
  });
  const receiveProduct = (product: Product) => startEditor({ title: '成品入库 · ' + product.name, fields: [
    { key: 'quantity', label: '入库数量（' + product.unit + '）', value: '', numeric: true, required: true },
    { key: 'remark', label: '备注（选填）', value: '' }
  ], submit: async v => { await stockIn(product.id, numberValue(v.quantity, '入库数量', true), '', v.remark); invalidateProducts(); } });
  const submitEditor = async () => {
    if (!editor || lock.current) return;
    const trimmed = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]));
    if (editor.fields.some(f => f.required && !trimmed[f.key])) { setFormError('请填写必填资料'); return; }
    lock.current = true; setSaving(true); setFormError('');
    try { await editor.submit(trimmed); setEditor(null); void Taro.showToast({ title: '保存成功', icon: 'success' }); await reload(); }
    catch (error) { setFormError(message(error)); }
    finally { lock.current = false; setSaving(false); }
  };
  const startProduction = async (order: CustomerOrder) => {
    if (lock.current) return;
    lock.current = true; setSaving(true);
    try { await updateOrder(order.id, { status: '生产中' }); await reload(); }
    catch (error) { void Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { lock.current = false; setSaving(false); }
  };
  const outbound = (order: CustomerOrder) => { Taro.setStorageSync('sg_outbound_order', order.id); void Taro.switchTab({ url: '/pages/outbound/index' }); };
  const button = (label: string, action: () => void, primary = false, disabled = false) => <Button className={primary ? styles.primary : styles.button} disabled={disabled || saving || undefined} onClick={action}>{label}</Button>;
  const fold = (key: string, label: string) => <Button className={styles.fold} aria-label={(collapsed[key] ? '展开' : '收起') + label} onClick={() => toggle(key)}>{collapsed[key] ? '展开 ›' : '收起⌃'}</Button>;
  const empty = (label: string) => <View className={styles.empty}>{label}</View>;

  return <View className={styles.page} data-testid='business-dashboard'>
    <View className={styles.header}>
      <Button className={styles.back} aria-label='返回' onClick={() => { if (Taro.getCurrentPages().length > 1) void Taro.navigateBack(); else void Taro.switchTab({ url: '/pages/home/index' }); }}>‹</Button>
      <View className={styles.heading}><Text className={styles.eyebrow}>曙光 · 纸板仓库</Text><Text className={styles.title}>业务总台</Text></View>
      {button(remote.loading ? '同步中' : '刷新', () => void reload(), false, remote.loading)}
    </View>
    <Text className={styles.subtitle}>库存 · 客户 · 发货</Text>
    <View className={styles.search}><Input aria-label='搜索全部业务' placeholder='搜公司、尺寸、货名或订单号' value={query} maxlength={120} onInput={e => setQuery(e.detail.value)} />{query && button('清空', () => setQuery(''))}</View>
    <View className={styles.filters}>{([['all', '全部'], ['boards', '纸板'], ['customers', '客户 / 成品'], ['orders', '发货']] as const).map(([key, label]) => <Button key={key} className={filter === key ? styles.active : styles.filter} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</Button>)}</View>
    <Text className={styles.summary}>{remote.loading ? '正在同步业务数据…' : remote.loadError ? '同步失败，请重试' : customers.length + ' 家客户 · ' + boards.length + ' 种纸板 · ' + data.orders.filter(o => o.status === '生产中' && remainingOrder(o, data.transactions) > 0).length + ' 单待发'}</Text>
    {remote.loadError && <View className={styles.error} role='alert'><Text>{remote.loadError}</Text>{button('重新读取', () => void reload())}</View>}
    {remote.ready && <View className={styles.sections}>
      {hasSection('boards') && <View className={styles.section} data-testid='boards-section'>
        <View className={styles.sectionHead}><View className={styles.grow}><View className={styles.moduleHeading}><Button className={styles.moduleLink} onClick={() => open('/pages/board-stock/index')}>纸板库存 ›</Button>{fold('boards', '纸板库存')}</View><Text className={styles.hint}>查看余量、规格与来料批次</Text></View>{!collapsed.boards && button('＋ 来料入库', () => open('/pages/board-receive/index'), true, !writable)}</View>
        {!collapsed.boards && <View>{!visibleBoards.length && empty(query ? '没有匹配的纸板' : '还没有纸板，点击“来料入库”记第一笔。')}{visibleBoards.map(group => <View className={styles.record} key={group.key} data-testid='board-row'>
          <View className={styles.row}><View><Text className={styles.spec}>纸板：{boardSpec(group.batches[0])} cm</Text><Text className={styles.hint}>对应纸箱：{cartonSpec(group.batches[0])} cm</Text><Text className={styles.hint}>{group.batches[0].layers}层 · {group.batches[0].fluteType}楞</Text></View><Text className={styles.stock}>{group.quantity.toLocaleString()} 张</Text></View>
          <Text className={styles.hint}>{[...new Set(group.batches.map(b => b.supplier))].join(' / ')}</Text>
          <View className={styles.actions}>{button(expanded[group.key] ? '收起明细' : '查看批次明细', () => toggleRow(group.key))}{button('同规格入库', () => open('/pages/board-receive/index?from=' + encodeURIComponent(group.batches[0].id)), false, !writable)}</View>
          {expanded[group.key] && group.batches.map(batch => <View className={styles.batch} key={batch.id}><Text className={styles.spec}>{batch.supplier} · 当前余量 {batch.remainingQty} 张</Text><Text className={styles.hint}>送货日期：{batch.date} · 送货单号：{batch.deliveryNo || '未填写'}</Text><Text className={styles.hint}>库位：{batch.location || '未填'} · 实收：{batch.receivedQty} 张</Text><View className={styles.actions}>{button('详情 / 标签', () => open('/pages/board-detail/index?id=' + encodeURIComponent(batch.id)))}{button('登记领料', () => open('/pages/board-outbound/index?id=' + encodeURIComponent(batch.id)), false, !writable || batch.remainingQty <= 0)}</View></View>)}
        </View>)}</View>}
      </View>}
      {hasSection('customers') && <View className={styles.section} data-testid='customers-section'>
        <View className={styles.sectionHead}><View className={styles.grow}><View className={styles.moduleHeading}><Button className={styles.moduleLink} onClick={() => open('/pages/customers/index')}>客户与成品 ›</Button>{fold('customers', '客户与成品')}</View><Text className={styles.hint}>点标题管理客户与账款，展开查看规格与库存</Text></View>{!collapsed.customers && button('＋ 新增客户', () => editCompany(), true, !writable)}</View>
        {!collapsed.customers && <View>{!visibleCustomers.length && empty(query ? '没有匹配的客户或尺寸' : '先新增一家公司，再添加它常用的尺寸。')}{visibleCustomers.map(customer => {
          const specs = customer.dimension?.specs || [];
          const filteredSpecs = matchesQuery(query, [customer.name, customer.account?.contact, customer.account?.phone, customer.account?.address]) ? specs : specs.filter(s => specMatches(query, s));
          const visibleSpecs = query || expanded[customer.key] ? filteredSpecs : filteredSpecs.slice(0, 3);
          return <View className={styles.customer} key={customer.key} data-testid='customer-row'>
            <View className={styles.row}><View className={styles.grow}><Text className={styles.company}>{customer.name}</Text><Text className={styles.hint}>{[customer.account?.contact, customer.account?.phone, customer.account?.address].filter(Boolean).join(' · ') || '客户信息未填写'}</Text></View><View className={styles.actions}>{customer.account ? button('客户资料', () => open('/pages/customer-edit/index?id=' + customer.account!.id)) : button('修改公司', () => editCompany(customer), false, !writable)}{button('＋ 规格', () => editSpec(customer), false, !writable)}</View></View>
            {customer.ambiguous && <Text className={styles.hint}>存在同名客户，请先在客户管理核对。</Text>}
            {!specs.length && empty('还没有尺寸，点击“＋ 规格”添加。')}
            {visibleSpecs.map(spec => {
              const products = matchingProducts(spec, data.products);
              return <View className={styles.record} key={spec.id} data-testid='spec-row'><View className={styles.row}><View><Text className={styles.spec}>{spec.size} {spec.sizeUnit}</Text><Text className={styles.hint}>{[spec.kind, spec.goods, spec.material].filter(Boolean).join(' · ')}</Text></View><Text className={styles.stock}>{spec.kind === '纸板' ? '纸板尺寸资料' : products.length === 1 ? '库存 ' + products[0].stock + ' ' + spec.unit : products.length ? '多个匹配商品' : '未关联库存商品'}</Text></View><View className={styles.actions}>{button('编辑规格', () => editSpec(customer, spec), false, !writable)}{spec.kind === '成品' && button('成品入库', () => products.length === 1 ? receiveProduct(products[0]) : open('/pages/products/index'), false, !writable)}{button('开单', () => createOrder(customer, spec), true, !writable || customer.ambiguous)}</View></View>;
            })}
            {!query && specs.length > 3 && button(expanded[customer.key] ? '收起规格' : '展开全部 ' + specs.length + ' 个规格', () => toggleRow(customer.key))}
          </View>;
        })}</View>}
      </View>}
      {hasSection('orders') && <View className={styles.section} data-testid='orders-section'>
        <View className={styles.sectionHead}><View className={styles.grow}><View className={styles.moduleHeading}><Button className={styles.moduleLink} onClick={() => void Taro.switchTab({ url: '/pages/outbound/index' })}>订单与发货 ›</Button>{fold('orders', '订单与发货')}</View><Text className={styles.hint}>开单、确认出库与打印送货单</Text></View></View>
        {!collapsed.orders && <View><View className={styles.subheading}><Button className={styles.moduleLink} onClick={() => open('/pages/orders/index')}>订单列表</Button>{fold('orderList', '订单列表')}</View>
          {!collapsed.orderList && <View>{!visibleOrders.length && empty(query ? '没有匹配的订单' : '还没有订单，在客户规格旁点击“开单”即可。')}{visibleOrders.map(order => <View className={styles.record} key={order.id} data-testid='order-row'><View className={styles.row}><Text className={styles.spec}>{order.customer_name || '未关联客户'} · {order.order_no}</Text><Text className={styles.status}>{order.status}</Text></View><Text className={styles.hint}>{order.specification || '未填写规格'} · {order.quantity} {order.unit} · {formatMoney(order.amount)}</Text><Text className={styles.hint}>交期：{order.delivery_date || '未定'} · 剩余待发 {remainingOrder(order, data.transactions)} {order.unit}</Text><View className={styles.actions}>{order.status === '待生产' && button('开始生产', () => void startProduction(order), false, !writable)}{order.status === '生产中' && button('核对出库', () => outbound(order), true, !writable || remainingOrder(order, data.transactions) === 0)}{button('管理订单', () => open('/pages/orders/index'))}</View></View>)}</View>}
          <View className={styles.subheading}><Text className={styles.spec}>送货单记录</Text>{fold('notes', '送货单记录')}</View>
          {!collapsed.notes && <View>{!visibleShipments.length && empty(query ? '没有匹配的送货单' : '暂无出库单，确认发货后自动生成。')}{visibleShipments.map(note => <View className={styles.record} key={note.key} data-testid='shipment-row'><Text className={styles.spec}>{note.rows[0].customer_name || '未关联客户'} · {note.no}</Text><Text className={styles.hint}>{formatShortTime(note.rows[0].created_at)} · {note.rows.length} 项 · {formatMoney(note.rows.reduce((sum, tx) => sum + Number(tx.amount || 0), 0))}</Text><View className={styles.actions}>{button('查看单据', () => setPreview(note.rows))}{button('打印送货单', () => open('/pages/print-center/index?transaction_id=' + note.rows[0].id))}</View></View>)}</View>}
        </View>}
      </View>}
    </View>}
    <View className={styles.ledger} data-testid='ledger-entry'><View><Text className={styles.sectionTitle}>账单流水</Text><Text className={styles.hint}>收支与往来账款 · 送货单、签收单、收款凭证</Text></View>{button('查看账单流水', () => open('/pages/ledger/index'), true)}</View>
    {!!preview.length && <OutboundDocument transactions={preview} onClose={() => setPreview([])} />}
    <View className={styles.tools}><button className={styles.button} aria-label='进入标签打印' onClick={() => open('/pages/qr-test/index')}>标签打印</button><button className={styles.button} aria-label='进入打印中心' onClick={() => open('/pages/print-center/index')}>打印中心</button><button className={styles.button} aria-label='进入客户尺寸本' onClick={() => open('/pages/customer-desk/index')}>客户尺寸本</button></View>
    {editor && <View className={styles.overlay}><View className={styles.dialog} role='dialog' aria-modal='true' aria-label={editor.title}><Text className={styles.sectionTitle}>{editor.title}</Text>{editor.hint && <Text className={styles.hint}>{editor.hint}</Text>}{editor.fields.map(field => <View className={styles.field} key={field.key}><Text>{field.label}</Text>{field.options ? <Picker disabled={saving || undefined} range={field.options} value={field.options.indexOf(values[field.key])} onChange={e => setValues(state => ({ ...state, [field.key]: field.options![Number(e.detail.value)] }))}><View className={styles.select}>{values[field.key]} ▾</View></Picker> : <Input disabled={saving || undefined} aria-label={field.label} type={field.numeric ? 'digit' : 'text'} value={values[field.key]} maxlength={100} onInput={e => setValues(state => ({ ...state, [field.key]: e.detail.value }))} />}</View>)}{formError && <View className={styles.error} role='alert'>{formError}</View>}<View className={styles.actions}>{button('取消', () => setEditor(null))}{button(saving ? '保存中…' : '确认', () => void submitEditor(), true)}</View></View></View>}
  </View>;
}
