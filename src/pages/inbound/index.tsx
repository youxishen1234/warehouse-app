import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker, Button } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { addDeliveryNote, deliveryNoteCsvUrl, getCustomers, getDeliveryNotes, getSuppliers, voidDeliveryNote, type DeliveryNote } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { downloadCsv } from '@/services/download';
import { useSharedRefresh } from '@/services/shared-refresh';
import { dimensions, localDate, numberValue, previewAmount, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import { formatMoney, formatMoneyPreview } from '@/utils/format';
import StockProductPicker from '@/components/StockProductPicker';
import StockEntryLayout from '@/components/StockEntryLayout';
import { formatSpecificationInput } from '../print-center/specification-input';
import type { Customer, Product, Supplier } from '@/types';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';
import { findCustomerSpecification, matchCustomerSpecification } from '../../../backend/production-pricing';
import type { CustomerSpecification } from '../../../backend/production-pricing';
import { customerSpecificationText, matchingProductsForSpecification, uniqueCustomerSpecification, validatedCustomerSpecification } from './customer-pricing';

type EditableLine = { key: string; product_id: number | null; specification: string; quantity: string; quantityEdited: boolean; unit_price: string; delivered_qty: string; customer_spec_id: string | null; customer_quote_invalid: boolean };
const newLine = (): EditableLine => ({ key: `${Date.now()}-${Math.random()}`, product_id: null, specification: '', quantity: '1', quantityEdited: false, unit_price: '0', delivered_qty: '1', customer_spec_id: null, customer_quote_invalid: false });
const applyProduct = (line: EditableLine, product: Product): EditableLine => ({ ...line, product_id: product.id, specification: product.specification || '', unit_price: String(product.price), customer_spec_id: null, customer_quote_invalid: false });
const applyCustomerSpecification = (line: EditableLine, product: Product | undefined, specification: CustomerSpecification): EditableLine => ({
  ...line,
  product_id: product?.id ?? null,
  specification: customerSpecificationText(specification) || product?.specification || line.specification,
  unit_price: String(specification.price),
  customer_spec_id: specification.id,
  customer_quote_invalid: false
});
const applyProductForCustomer = (line: EditableLine, product: Product, customer: Customer | undefined): EditableLine => {
  if (!customer) return applyProduct(line, product);
  if (line.customer_spec_id) {
    try {
      const matched = matchCustomerSpecification(customer, { ...product, specification: product.specification || '' }, line.customer_spec_id);
      return applyCustomerSpecification(line, product, matched.specification);
    } catch {
      // Product changes must never carry a stale customer quote.
    }
  }
  const specification = uniqueCustomerSpecification(customer, product);
  return specification ? applyCustomerSpecification(line, product, specification) : applyProduct(line, product);
};
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

type InboundNoteRowProps = { note: DeliveryNote; onOpen: (note: DeliveryNote) => void };
const InboundNoteRow = React.memo(function InboundNoteRow({ note, onOpen }: InboundNoteRowProps) {
  const isProductionNote = note.source_type === 'production';
  const isCustomerNote = note.party_type === 'customer' || (note.party_type == null && note.customer_id != null);
  const partyName = isCustomerNote ? note.customer_name : note.supplier_name;
  const partyLabel = isCustomerNote ? '客户' : '供货商';
  const sourceLabel = isProductionNote
    ? (note.customer_id != null ? `自产成品入库 · 客户：${note.customer_name || '未关联'}` : '自产成品入库 · 未关联客户')
    : `${partyLabel}：${partyName || `未关联${partyLabel}`}`;
  return <View className={styles.note} onClick={() => onOpen(note)}>
    <View className={styles.noteTop}><Text>{note.work_order_no || `入库单 #${note.id}`}</Text><Text className={styles.noteAmount}>{formatMoney(note.total_amount)}</Text></View>
    <Text className={styles.noteMeta}>{sourceLabel} · {note.lines.length} 项商品</Text>
    <Text className={styles.noteMeta}>{note.date} · {note.voided_at ? '已作废' : '已入库'}</Text>
  </View>;
});

export default function InboundPage() {
  const cartonOnly = useRouter().params.kind === 'carton';
  const [parties, setParties] = useState<Supplier[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [billingCustomerId, setBillingCustomerId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [date, setDate] = useState(() => localDate());
  const [workOrder, setWorkOrder] = useState('');
  const [partyId, setPartyId] = useState<number | null>(null);
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [operator, setOperator] = useState('');
  const [freight, setFreight] = useState('0');
  const [remark, setRemark] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [ready, setReady] = useState(false);
  const [preview, setPreview] = useState<DeliveryNote | null>(null);
  const [transitId, setTransitId] = useState<number | null>(null);
  const busy = useRef(false);
  const lastLoadAt = useRef(0);
  const didShowOnce = useRef(false);
  const productMap = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const activeCustomers = useMemo(() => customers.filter(customer => !customer.deleted_at), [customers]);
  const billingCustomer = activeCustomers.find(customer => customer.id === billingCustomerId);
  const selectedBillingCustomer = customers.find(customer => customer.id === billingCustomerId);
  const customerOptions = [
    { id: null as number | null, label: '不关联客户' },
    ...activeCustomers.map(customer => ({ id: customer.id, label: customer.name })),
    ...(billingCustomerId != null && !billingCustomer
      ? [{ id: billingCustomerId, label: `${selectedBillingCustomer?.name || '所选客户'}（已停用或不可用）` }]
      : [])
  ];
  const billingCustomerIndex = Math.max(0, customerOptions.findIndex(option => option.id === billingCustomerId));
  const loadInboundData = useCallback(async () => {
    lastLoadAt.current = Date.now();
    const [loadedParties, loadedCustomers, p, n] = await Promise.all([
      cartonOnly ? Promise.resolve([] as Supplier[]) : getSuppliers(),
      cartonOnly ? getCustomers() : Promise.resolve([] as Customer[]),
      loadProducts(true),
      getDeliveryNotes()
    ]);
    const filteredNotes = cartonOnly ? n.filter(note => note.source_type === 'production') : n;
    return { parties: loadedParties, customers: loadedCustomers, products: cartonOnly ? p.filter(item => item.category !== '纸板' && (item.category === '纸箱' || /\d\s*[×xX*]\s*\d.*[×xX*]/.test(item.specification || ''))) : p, notes: filteredNotes.slice(0, 8) };
  }, [cartonOnly]);
  const remote = useRemoteData(loadInboundData, { parties: [] as Supplier[], customers: [] as Customer[], products: [] as Product[], notes: [] as DeliveryNote[] });
  const { reload: remoteReload } = remote;
  const load = useCallback((forceOrRevision: boolean | string = false) => {
    const startedAt = Date.now();
    const force = forceOrRevision === true || typeof forceOrRevision === 'string';
    if (!force && startedAt - lastLoadAt.current < 250) return Promise.resolve();
    lastLoadAt.current = startedAt;
    return remoteReload();
  }, [remoteReload]);
  // useRemoteData owns loadSequence/requestId; if (current !== loadSequence.current), stale responses are discarded.
  useEffect(() => {
    if (!remote.loading && remote.ready) { setParties(remote.data.parties); setCustomers(remote.data.customers); setProducts(remote.data.products); setNotes(remote.data.notes); setReady(true); setLoadError(''); }
    if (remote.loadError) { setReady(false); setLoadError(remote.loadError); }
  }, [remote.loading, remote.ready, remote.loadError, remote.data]);
  useSharedRefresh(load);
  useDidShow(() => {
    const firstShow = !didShowOnce.current;
    didShowOnce.current = true;
    if (!firstShow || remote.loadError) void load(true);
    else if (Date.now() - lastLoadAt.current >= 250) void load();
    const transit = Taro.getStorageSync('sg_transit');
    if (transit?.product_id) { setTransitId(transit.product_id); Taro.removeStorageSync('sg_transit'); }
  });
  useEffect(() => {
    if (!transitId || !ready || saving) return;
    const product = transitId == null ? undefined : productMap.get(transitId);
    if (product) setLines(current => {
      if (current.some(line => line.product_id === product.id)) return current;
      const blank = current.findIndex(line => !line.product_id);
      const applySelectedProduct = (line: EditableLine) => cartonOnly ? applyProductForCustomer(line, product, billingCustomer) : applyProduct(line, product);
      return blank < 0 ? [...current, applySelectedProduct(newLine())] : current.map((line, index) => index === blank ? applySelectedProduct(line) : line);
    });
    setTransitId(null);
  }, [transitId, productMap, ready, saving, cartonOnly, billingCustomer]);
  const party = parties.find(item => item.id === partyId);
  const openPreview = useCallback((note: DeliveryNote) => setPreview(note), []);
  const calculated = useMemo(() => lines.map(line => {
    const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
    const [length, width] = dimensions(line.specification, selected);
    const delivered = Math.max(0, Number(line.delivered_qty) || 0);
    return { square: roundDecimal(delivered * length * width / 1000000, 4), amount: previewAmount(line.delivered_qty, line.unit_price) };
  }), [lines, productMap]);
  const totalSquare = useMemo(() => roundDecimal(calculated.reduce((sum, item) => sum + item.square, 0), 4), [calculated]);
  const totalAmount = useMemo(() => calculated.every(item => Number.isFinite(item.amount)) ? roundDecimal(calculated.reduce((sum, item) => sum + item.amount, 0), 2) : Number.NaN, [calculated]);
  const updateLine = (key: string, patch: Partial<EditableLine>) => {
    if (!busy.current) setLines(current => current.map(line => {
      if (line.key !== key) return line;
      return { ...line, ...patch, ...(patch.delivered_qty !== undefined && !line.quantityEdited && patch.quantity === undefined ? { quantity: patch.delivered_qty } : {}) };
    }));
  };
  const changeBillingCustomer = (customerId: number | null) => {
    if (busy.current) return;
    const customer = customerId == null ? undefined : activeCustomers.find(item => item.id === customerId);
    if (customerId != null && !customer) {
      Taro.showToast({ title: '该客户已停用或不可用，请重新选择', icon: 'none' });
      return;
    }
    setBillingCustomerId(customer?.id ?? null);
    setLines(current => current.map(line => {
      const product = line.product_id == null ? undefined : productMap.get(line.product_id);
      if (customer && product) {
        const specification = uniqueCustomerSpecification(customer, product);
        return specification
          ? applyCustomerSpecification(line, product, specification)
          : { ...line, product_id: product.id, specification: product.specification || line.specification, unit_price: '', customer_spec_id: null, customer_quote_invalid: false };
      }
      if (!customer && product) return applyProduct(line, product);
      return { ...line, product_id: null, specification: '', unit_price: '', customer_spec_id: null, customer_quote_invalid: false };
    }));
  };
  const changeCustomerSpecification = (line: EditableLine, specId: string) => {
    if (busy.current) return;
    if (!specId || !billingCustomer) {
      const product = line.product_id == null ? undefined : productMap.get(line.product_id);
      updateLine(line.key, product ? applyProduct(line, product) : { ...line, specification: '', unit_price: '', customer_spec_id: null, customer_quote_invalid: false });
      return;
    }
    const specification = findCustomerSpecification(billingCustomer, specId);
    if (!specification || typeof specification.price !== 'number' || !Number.isFinite(specification.price) || specification.price < 0) {
      Taro.showToast({ title: '客户规格已变更或单价无效，请刷新客户资料', icon: 'none' });
      return;
    }
    const candidates = matchingProductsForSpecification(billingCustomer, products, specification.id);
    const currentProduct = line.product_id == null ? undefined : productMap.get(line.product_id);
    const product = currentProduct && candidates.some(item => item.id === currentProduct.id)
      ? currentProduct
      : candidates.length === 1 ? candidates[0] : undefined;
    updateLine(line.key, applyCustomerSpecification(line, product, specification));
  };
  useEffect(() => {
    if (!cartonOnly || remote.loading || !remote.ready || billingCustomerId == null) return;
    if (!billingCustomer) {
      setLines(current => current.map(line => line.customer_spec_id
        ? { ...line, customer_spec_id: null, unit_price: '', customer_quote_invalid: true }
        : line));
      return;
    }
    setLines(current => current.map(line => {
      if (!line.customer_spec_id) return line;
      const product = line.product_id == null ? undefined : productMap.get(line.product_id);
      const specification = validatedCustomerSpecification(billingCustomer, product, line.customer_spec_id);
      if (!specification) {
        return { ...line, customer_spec_id: null, unit_price: '', customer_quote_invalid: true };
      }
      return applyCustomerSpecification(line, product, specification);
    }));
  }, [cartonOnly, remote.loading, remote.ready, billingCustomerId, billingCustomer, productMap]);
  const save = async () => {
    if (busy.current) return;
    // Hold the same lock while validating and awaiting over-receipt confirmation.
    // A second tap must not open another confirmation and submit the same draft.
    busy.current = true; setSaving(true);
    try {
      if (!Number.isFinite(totalAmount)) throw new Error('金额超出支持范围，请减少数量或单价');
      if (!ready || loadError) throw new Error(`请先刷新商品${cartonOnly ? '与客户' : '与供应商'}数据`);
      if (!cartonOnly && partyId && !party) throw new Error('供货商已停用，请重新选择');
      if (cartonOnly && billingCustomerId != null && !billingCustomer) throw new Error('所选客户已停用或资料已变更，请刷新后重新选择');
      if (new Set(lines.map(line => line.product_id)).size !== lines.length) throw new Error('同一商品不能重复，请合并数量');
      const payload = lines.map((line, index) => {
        const product = line.product_id == null ? undefined : productMap.get(line.product_id);
        if (!product) throw new Error(`第 ${index + 1} 行请选择有效商品`);
        const customerSpecification = cartonOnly && billingCustomer && line.customer_spec_id
          ? matchCustomerSpecification(billingCustomer, { ...product, specification: product.specification || '' }, line.customer_spec_id).specification
          : null;
        return {
          product_id: product.id,
          product_name: product.name,
          specification: line.specification.trim(),
          material: product.material || '',
          unit: product.unit,
          quantity: numberValue(line.quantity, `第 ${index + 1} 行计划数量`, true),
          delivered_qty: numberValue(line.delivered_qty, `第 ${index + 1} 行${cartonOnly ? '本次完工数量' : '实际入库数量'}`, cartonOnly),
          unit_price: customerSpecification?.price ?? numberValue(line.unit_price, `第 ${index + 1} 行${cartonOnly ? '入库单价' : '单价'}`),
          ...(customerSpecification ? { customer_spec_id: customerSpecification.id } : {})
        };
      });
      const overReceived = payload.filter(line => line.delivered_qty > line.quantity);
      if (overReceived.length) {
        const names = overReceived.map(line => `${line.product_name}（计划 ${line.quantity}，${cartonOnly ? '完工' : '实收'} ${line.delivered_qty}）`).join('；');
        const content = cartonOnly
          ? `${names}。超出计划部分计入成品库存；${billingCustomer ? '入库金额计入所选客户账单和待收款，已记账纸箱出库不重复计款' : '未关联客户时只增加库存，不计客户账单'}，是否继续？`
          : `${names}。超收部分会一并计入库存和应付，是否继续？`;
        const confirmation = await Taro.showModal({ title: cartonOnly ? '完工数量超过计划' : '实际入库超过计划', content, confirmText: '继续入库', cancelText: '返回修改' });
        if (!confirmation.confirm) return;
      }
      const freightValue = cartonOnly ? 0 : numberValue(freight, '运费');
      const note = await addDeliveryNote({ date, work_order_no: workOrder.trim(), ...(cartonOnly ? { source_type: 'production' as const, party_type: billingCustomer ? 'customer' as const : null, customer_id: billingCustomer?.id ?? null, customer_name: billingCustomer?.name || '', supplier_id: null, supplier_name: '', driver_phone: '', vehicle_no: '', freight: 0 } : { party_type: 'supplier' as const, customer_id: null, customer_name: '', supplier_id: partyId, supplier_name: party?.name || '', driver_phone: driverPhone.trim(), vehicle_no: vehicleNo.trim(), freight: freightValue }), remark: remark.trim(), lines: payload, operator: operator.trim() });
      invalidateProducts();
      setPreview(note); setWorkOrder(''); setDriverPhone(''); setVehicleNo(''); setOperator(''); setFreight('0'); setRemark(''); setPartyId(null); setBillingCustomerId(null); setLines([newLine()]);
      Taro.showToast({ title: '入库单保存成功', icon: 'success' }); await load();
    } catch (error) { Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { busy.current = false; setSaving(false); }
  };
  const voidNote = async (note: DeliveryNote) => {
    if (busy.current || note.voided_at) return;
    busy.current = true; setSaving(true);
    try {
      const content = note.source_type === 'production'
        ? (note.customer_id != null
          ? '将撤回全部明细的成品库存及本单对应的客户应收，保留原单历史。已使用的库存或已结算款项可能阻止作废。'
          : '将撤回全部明细的成品库存，保留原单历史。')
        : '将撤回全部明细的库存和应付款，保留原单历史。已使用的库存或已结算款项可能阻止作废。';
      const confirmation = await Taro.showModal({ title: '作废整张入库单', content });
      if (!confirmation.confirm) return;
      const result = await voidDeliveryNote(note.id); setPreview(result); await load();
      Taro.showToast({ title: '入库单已作废', icon: 'success' });
    } catch (error) { Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { busy.current = false; setSaving(false); }
  };
  const exportCsv = async (note: DeliveryNote) => {
    try { await downloadCsv(deliveryNoteCsvUrl(note.id), `delivery-note-${note.id}.csv`); }
    catch (error) { Taro.showToast({ title: message(error), icon: 'none' }); }
  };
  return <StockEntryLayout title={cartonOnly ? '纸箱生产入库' : '入库'} subtitle={cartonOnly ? '自产纸箱补录入库，不是采购；已在“生产”登记完工的同批纸箱不再重复录入。先备货可不关联客户，之后接单出库。' : '选货物，填数量，确认保存。'} onRefresh={() => { void load(true); }} busy={saving}>
    <View className={styles.page}>
      {loadError && <View role='alert' className={styles.error}>{loadError}<Button disabled={saving} className={styles.textButton} onClick={() => { void load(true); }}>重新读取</Button></View>}
      {cartonOnly && <>
        <View className={styles.field}>
          <Text className={styles.fieldLabel}>客户（选填）</Text>
          <Picker aria-label='选择客户' disabled={saving} range={customerOptions.map(option => option.label)} value={billingCustomerIndex} onChange={e => { const option = customerOptions[Number(e.detail.value)]; changeBillingCustomer(option?.id ?? null); }}>
            <View className={styles.picker}>{billingCustomer?.name || (billingCustomerId != null ? `${selectedBillingCustomer?.name || '所选客户'}（已停用或不可用，请重新选择）` : '不关联客户 · 只增加库存')}<Text>⌄</Text></View>
          </Picker>
        </View>
        <Text className={styles.hint}>{billingCustomerId != null && !billingCustomer ? '所选客户已停用或资料不可用；请重新选择客户，或主动改为不关联后再保存。' : billingCustomer ? '自产入库金额计入客户账单和待收款；已入账纸箱出库不重复计款。' : '未关联客户时只增加纸箱库存，不计客户账单。'}</Text>
      </>}
      {!cartonOnly && <View className={styles.field}>
        <Text className={styles.fieldLabel}>供货商</Text>
        <Picker aria-label='选择供货商' disabled={saving} range={['不关联供货商', ...parties.map(item => item.name)]} value={Math.max(0, parties.findIndex(item => item.id === partyId) + 1)} onChange={e => { const index = Number(e.detail.value); setPartyId(index ? parties[index - 1]?.id || null : null); }}><View className={styles.picker}>{party?.name || (partyId ? '供货商已停用，请重新选择' : '选择供货商')}<Text>⌄</Text></View></Picker>
      </View>}
      {lines.map((line, index) => {
        const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
        const unit = selected?.unit || '单位';
        const customerSpecifications = billingCustomer?.specs || [];
        const selectedCustomerSpecification = billingCustomer && line.customer_spec_id ? findCustomerSpecification(billingCustomer, line.customer_spec_id) : null;
        const customerSpecMatches = selectedCustomerSpecification && billingCustomer
          ? matchingProductsForSpecification(billingCustomer, products, selectedCustomerSpecification.id)
          : [];
        const needsManualProduct = Boolean(selectedCustomerSpecification && !customerSpecMatches.some(item => item.id === selected?.id));
        return <View className={styles.lineCard} key={line.key}>
          <View className={styles.lineHead}><Text className={styles.fieldLabel}>{lines.length > 1 ? `货物 ${index + 1}` : '货物名称'}</Text>{lines.length > 1 && <Button disabled={saving} aria-label={`移除货物 ${index + 1}`} className={styles.remove} onClick={() => { if (!busy.current) setLines(current => current.filter(item => item.key !== line.key)); }}>移除</Button>}</View>
          <StockProductPicker products={products} value={line.product_id} disabled={saving} excluded={lines.filter(item => item.key !== line.key).map(item => item.product_id || 0)} onSelect={product => updateLine(line.key, cartonOnly ? applyProductForCustomer(line, product, billingCustomer) : applyProduct(line, product))} />
          {cartonOnly && billingCustomer && <View className={styles.field}>
            <Text className={styles.fieldLabel}>客户常用规格</Text>
            <Picker aria-label={`货物 ${index + 1} 客户常用规格`} disabled={saving} range={['手动录入（不匹配客户报价）', ...customerSpecifications.map(spec => `${spec.goods} · ${customerSpecificationText(spec)} · ${spec.material} · ${spec.unit} · ${formatMoney(spec.price)}`)]} value={Math.max(0, customerSpecifications.findIndex(spec => spec.id === line.customer_spec_id) + 1)} onChange={e => { const option = Number(e.detail.value); changeCustomerSpecification(line, option ? customerSpecifications[option - 1]?.id || '' : ''); }}>
              <View className={styles.picker}>{selectedCustomerSpecification ? `${selectedCustomerSpecification.goods} · ${customerSpecificationText(selectedCustomerSpecification)} · ${selectedCustomerSpecification.material} · ${selectedCustomerSpecification.unit} · ${formatMoney(selectedCustomerSpecification.price)}` : customerSpecifications.length ? '选择客户常用规格（可选）' : '暂无客户常用规格，可手动填价'}<Text>⌄</Text></View>
            </Picker>
            {line.customer_quote_invalid
              ? <Text className={styles.hint}>原客户规格报价已失效，单价已清空；请重新选择有效客户规格或手动录入新价。</Text>
              : selectedCustomerSpecification && needsManualProduct
              ? <Text className={styles.hint}>{customerSpecMatches.length ? '该规格对应多个现有商品，请手动选择匹配的纸箱商品。' : '该规格未匹配到现有纸箱商品，请手动选择已有商品；不会自动创建商品。'}</Text>
              : <Text className={styles.hint}>{line.customer_spec_id ? '客户规格单价已同步（只读），客户资料变化后刷新会同步最新报价。' : '未匹配客户报价；可手动填写入库单价，不修改客户或商品价格。'}</Text>}
          </View>}
          <View className={styles.field}><Text className={styles.fieldLabel}>规格尺寸</Text><Input aria-label={`货物 ${index + 1} 规格尺寸`} disabled={saving} className={styles.input} value={line.specification} onInput={e => {
            const specification = cartonOnly ? formatSpecificationInput(e.detail.value, line.specification) : e.detail.value;
            updateLine(line.key, line.customer_spec_id ? { specification, customer_spec_id: null, unit_price: selected ? String(selected.price) : '', customer_quote_invalid: false } : { specification });
          }} /></View>
          <View className={styles.grid}>
            <View><Text className={styles.fieldLabel}>{cartonOnly ? `本次完工数量（${unit}）` : `入库数量（${unit}）`}</Text><Input aria-label={`货物 ${index + 1} ${cartonOnly ? '本次完工数量' : '实际入库数量'}`} disabled={saving} className={styles.input} type='digit' value={line.delivered_qty} onInput={e => updateLine(line.key, { delivered_qty: sanitizeDecimalInput(e.detail.value, 6) })} /></View>
            <View><Text className={styles.fieldLabel}>{cartonOnly && line.customer_spec_id ? `客户单价（只读，元/${unit}）` : cartonOnly && billingCustomer ? `入库单价（未匹配报价，元/${unit}）` : cartonOnly ? `入库单价（元/${unit}）` : `单价（元/${unit}）`}</Text><Input aria-label={`货物 ${index + 1} ${cartonOnly ? '入库单价' : '单价'}`} disabled={saving || (cartonOnly && line.customer_spec_id != null)} className={styles.input} type='digit' value={line.unit_price} onInput={e => updateLine(line.key, { unit_price: sanitizeDecimalInput(e.detail.value, 2), customer_quote_invalid: false })} /></View>
          </View>
          {cartonOnly && <><View className={styles.amountNote} data-testid={`inbound-line-amount-${index + 1}`}><Text>入库金额（自动）</Text><Text>{formatMoneyPreview(calculated[index].amount)}</Text></View><Text className={styles.hint}>入库金额＝完工数量×入库单价，修改即重算</Text></>}
          {selected && <Text className={styles.stockNote}>库存 {selected.stock}{unit} → {roundDecimal(selected.stock + Math.max(0, Number(line.delivered_qty) || 0), 6)}{unit}</Text>}
          {line.delivered_qty.trim() && line.unit_price.trim() && !Number.isFinite(calculated[index].amount) && <View role='alert' className={styles.error}>金额超出支持范围，请减少数量或单价</View>}
        </View>;
      })}
      <Button disabled={saving} className={styles.addLine} onClick={() => { if (!busy.current) setLines(current => [...current, newLine()]); }}>＋ 添加货物</Button>
      <View className={styles.field}><Text className={styles.fieldLabel}>业务日期</Text><Picker aria-label='业务日期' disabled={saving} mode='date' value={date} onChange={e => setDate(e.detail.value)}><View className={styles.picker}>{date}<Text>⌄</Text></View></Picker></View>
      <Button disabled={saving} className={styles.detailsToggle} aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}><Text>更多信息</Text><Text>{detailsOpen ? '收起 −' : '展开 ＋'}</Text></Button>
      {detailsOpen && <View className={styles.detailsBody}>
        <View className={styles.field}><Text className={styles.fieldLabel}>{cartonOnly ? '生产工单编号' : '工单编号 / 采购单号'}</Text><Input aria-label={cartonOnly ? '生产工单编号' : '工单编号或采购单号'} disabled={saving} className={styles.input} value={workOrder} onInput={e => setWorkOrder(e.detail.value)} /></View>
        {lines.map((line, index) => {
          const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
          const [length, width] = dimensions(line.specification, selected);
          return <View key={line.key} className={styles.planField}><Text className={styles.fieldLabel}>{lines.length > 1 ? `货物 ${index + 1} · ` : ''}计划数量（{selected?.unit || '单位'}）</Text><Input aria-label={`货物 ${index + 1} 计划数量`} disabled={saving} className={styles.input} type='digit' value={line.quantity} onInput={e => updateLine(line.key, { quantity: sanitizeDecimalInput(e.detail.value, 6), quantityEdited: true })} /><Text className={styles.hint}>{cartonOnly ? (line.quantityEdited ? '已手动设置计划数量，后续修改完工数量不会覆盖。' : '默认与完工数量一致，有超计划或未达计划时可分别填写。') : (line.quantityEdited ? '已手动设置计划数量，后续修改实收数不会覆盖。' : '默认与实收数量一致，有超收或少收时可分别填写。')}</Text><Text className={styles.hint}>{length && width ? `实际面积 ${calculated[index].square.toFixed(4)} ㎡，按 ${length}×${width} mm × ${cartonOnly ? '完工' : '实收'}数量计算` : '未设置有效长宽，面积不统计；库存和金额正常计算'}</Text></View>;
        })}
        {!cartonOnly && <View className={styles.row}>
          <View><Text className={styles.fieldLabel}>司机电话</Text><Input aria-label='司机电话' disabled={saving} className={styles.input} value={driverPhone} onInput={e => setDriverPhone(e.detail.value)} /></View>
          <View><Text className={styles.fieldLabel}>车号</Text><Input aria-label='车号' disabled={saving} className={styles.input} value={vehicleNo} onInput={e => setVehicleNo(e.detail.value)} /></View>
        </View>}
        <View className={styles.row}>
          <View><Text className={styles.fieldLabel}>操作人</Text><Input aria-label='操作人' disabled={saving} className={styles.input} value={operator} onInput={e => setOperator(e.detail.value)} /></View>
          {!cartonOnly && <View><Text className={styles.fieldLabel}>运费（元）</Text><Input aria-label='运费' disabled={saving} className={styles.input} type='digit' value={freight} onInput={e => setFreight(sanitizeDecimalInput(e.detail.value, 2))} /></View>}
        </View>
        {!cartonOnly && <Text className={styles.hint}>运费单独记录，不计入货款或往来账单。</Text>}
        <View className={styles.field}><Text className={styles.fieldLabel}>备注</Text><Input aria-label='入库备注' disabled={saving} className={styles.input} maxlength={500} value={remark} onInput={e => setRemark(e.detail.value)} /></View>
        <Text className={styles.hint}>{cartonOnly ? (billingCustomer ? '这是自产完工入库，不是采购；本单入库金额计入所选客户账单和待收款。' : '这是自产完工入库，不是采购；不关联客户时只增加纸箱库存，不生成往来应付或应收。') : (party ? '本单货款计入所选供货商应付账单。' : '未关联供货商时，只更新库存，不登记供货商应付。')}</Text>
      </View>}
      <View className={styles.total}><Text>{lines.length} 项货物</Text><Text data-testid='inbound-total-amount'>{cartonOnly ? '入库金额合计' : '货款合计'} {formatMoneyPreview(totalAmount)}</Text></View>
      <Button disabled={saving || !ready} className={styles.saveButton} onClick={() => { void save(); }}>{saving ? '正在保存…' : '确认入库'}</Button>
      {preview && <View className={styles.preview}>
        <View className={styles.previewTop}><Text className={styles.previewTitle}>入库单 #{preview.id}{preview.voided_at ? ' · 已作废' : ''}</Text><Button className={styles.textButton} onClick={() => setPreview(null)}>收起</Button></View>
        <Text className={styles.previewMeta}>日期：{preview.date}　工单：{preview.work_order_no || '未填写'}</Text><Text className={styles.previewMeta}>{preview.source_type === 'production' ? `自产成品入库 · 客户：${preview.customer_id != null ? preview.customer_name || '未关联' : '未关联'}` : (preview.party_type === 'customer' || (preview.party_type == null && preview.customer_id != null) ? `客户：${preview.customer_name || '未关联'}` : `供货商：${preview.supplier_name || '未关联'}`)}　操作人：{preview.operator || '未填写'}</Text>
        {preview.lines.map((line, index) => <View className={styles.previewLine} key={index}><View><Text>{line.product_name}</Text><Text className={styles.hint}>{line.specification}</Text></View><View><Text>{preview.source_type === 'production' ? '完工' : '实收'} {line.delivered_qty}{line.unit}</Text><Text className={styles.hint}>计划 {line.quantity}{line.unit}</Text><Text>{preview.source_type === 'production' ? '入库金额 ' : ''}{formatMoney(line.amount || 0)}</Text><Text className={styles.hint}>{Number(line.square_meters || 0).toFixed(2)} ㎡</Text></View></View>)}
        <Text className={styles.previewTotal}>{preview.source_type === 'production' ? '入库金额' : '货款'} {formatMoney(preview.total_amount)} · 实际面积 {preview.total_square_meters.toFixed(4)} ㎡</Text>
        {(preview.driver_phone || preview.vehicle_no) && <Text className={styles.previewMeta}>{preview.driver_phone ? `司机电话：${preview.driver_phone}` : ''}{preview.driver_phone && preview.vehicle_no ? '　' : ''}{preview.vehicle_no ? `车号：${preview.vehicle_no}` : ''}</Text>}
        {(preview.source_type !== 'production' || Number(preview.freight || 0) > 0) && <Text className={styles.previewMeta}>运费 {formatMoney(Number(preview.freight || 0))}（单独记录）</Text>}
        <Button disabled={saving} className={styles.export} onClick={() => { void exportCsv(preview); }}>导出 CSV</Button>{!preview.voided_at && <Button disabled={saving} className={styles.voidButton} onClick={() => { void voidNote(preview); }}>作废整张入库单</Button>}
      </View>}
      <Button disabled={saving} className={styles.historyToggle} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><Text>最近入库单</Text><Text>{historyOpen ? '收起 −' : '查看 ＋'}</Text></Button>
      {historyOpen && (!notes.length ? <View className={styles.empty}>暂无入库单</View> : notes.map(note => <InboundNoteRow key={note.id} note={note} onOpen={openPreview} />))}
      {detailsOpen && <Text className={styles.hint}>本单实际面积 {totalSquare.toFixed(4)} ㎡</Text>}
    </View>
  </StockEntryLayout>;
}
