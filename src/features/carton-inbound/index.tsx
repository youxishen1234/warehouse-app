import React, { useCallback, useMemo, useRef, useState } from 'react';
/* eslint-disable react/forbid-elements */
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { addDeliveryNote, deliveryNoteCsvUrl, getCartonInboundCustomers, getDeliveryNotes, getSuppliers, voidDeliveryNote, type DeliveryNote } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { downloadCsv } from '@/services/download';
import { useSharedRefresh } from '@/services/shared-refresh';
import { localDate, numberValue, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import { formatMoney } from '@/utils/format';
import { DemoSheet, DemoField, DemoDetail } from '@/components/DemoUI';
import QuickSpecPicker from '@/components/QuickSpecPicker';
import type { PartyGood } from '@/components/PartySearchPanel';
import { formatSpecificationInput } from '@/pages/print-center/specification-input';
import type { Customer, Product, Supplier } from '@/types';
import { completeGood, matchingProducts, lineAmount, draftTotal } from './entry-model';


type EditableLine = {
  key: string; product_id: number | null; goods: string; specification: string; material: string; unit: string;
  quantity: string; quantityEdited: boolean; unit_price: string; delivered_qty: string;
  customer_spec_id: string | null; supplier_spec_id: string | null; create_product: boolean;
};
const newLine = (): EditableLine => ({ key: `${Date.now()}-${Math.random()}`, product_id: null, goods: '', specification: '', material: '', unit: '', quantity: '', quantityEdited: false, unit_price: '', delivered_qty: '', customer_spec_id: null, supplier_spec_id: null, create_product: false });
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const amountText = (value: number | null) => value == null ? '金额未记录' : Number.isFinite(value) ? formatMoney(value) : '金额超出范围';
const applyProduct = (line: EditableLine, product: Product): EditableLine => {
  const fromGood = Boolean(line.customer_spec_id || line.supplier_spec_id);
  return { ...line, product_id: product.id, create_product: false, goods: line.goods || product.name,
    specification: line.specification || product.specification || '', material: line.material || product.material || '', unit: line.unit || product.unit || '',
    unit_price: fromGood ? line.unit_price : String(product.price) };
};
const applyGood = (line: EditableLine, item: PartyGood, products: Product[], cartonOnly: boolean): EditableLine => {
  const matches = matchingProducts(item, products, cartonOnly);
  return { ...line, product_id: matches.length === 1 ? matches[0].id : null,
    goods: item.goods || '', specification: item.specification || '', material: item.material || '', unit: item.unit || '',
    unit_price: (item.unitPrice ?? item.price) == null ? '' : String(item.unitPrice ?? item.price), create_product: false,
    customer_spec_id: cartonOnly ? String(item.id) : null, supplier_spec_id: cartonOnly ? null : String(item.id) };
};

const InboundNoteRow = React.memo(function InboundNoteRow({ note, onOpen }: { note: DeliveryNote; onOpen: (note: DeliveryNote) => void }) {
  return <button type='button' className='demo-card' onClick={() => onOpen(note)}>{note.work_order_no || `入库单 #${note.id}`} · {note.date} · {formatMoney(note.total_amount)}</button>;
});

export default function InboundPage() {
  const cartonOnly = useRouter().params.kind !== 'purchase';
  const [parties, setParties] = useState<Supplier[]>([]), [customers, setCustomers] = useState<Customer[]>([]);
  const [partyId, setPartyId] = useState<number | null>(null), [billingCustomerId, setBillingCustomerId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]), [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);
  const [date, setDate] = useState(() => localDate()), [workOrder, setWorkOrder] = useState('');
  const [driverPhone, setDriverPhone] = useState(''), [vehicleNo, setVehicleNo] = useState(''), [operator, setOperator] = useState('');
  const [entryTime, setEntryTime] = useState(() => { const now = new Date(); return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; });
  const [location, setLocation] = useState('');
  const [freight, setFreight] = useState('0'), [remark, setRemark] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [costTotals, setCostTotals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false), [ready, setReady] = useState(false), [loadError, setLoadError] = useState(''), [historyError, setHistoryError] = useState('');
  const [preview, setPreview] = useState<DeliveryNote | null>(null);
  const [specDetails, setSpecDetails] = useState<Record<string, boolean>>({});
  const busy = useRef(false), sequence = useRef(0), loadedAt = useRef(0);
  const productMap = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const billingCustomer = customers.find(item => item.id === billingCustomerId && !item.deleted_at);
  const party = parties.find(item => item.id === partyId && !item.deleted_at);
  const selectedParty = cartonOnly ? billingCustomer : party;
  const goods = (selectedParty?.specs || []).filter(item => !cartonOnly || ((item.category || (item.kind === '纸板' ? '纸板' : '纸箱')) === '纸箱'));
  const totalAmount = draftTotal(lines);
  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - loadedAt.current < 250) return;
    loadedAt.current = Date.now();
    const current = ++sequence.current;
    const result = await Promise.allSettled([
      cartonOnly ? getCartonInboundCustomers() : getSuppliers(), loadProducts(true), getDeliveryNotes(), ...(cartonOnly ? [getSuppliers()] : [])
    ]);
    if (current !== sequence.current) return;
    const [partyResult, productResult, historyResult, supplierResult] = result;
    if (supplierResult?.status === 'fulfilled') setParties(supplierResult.value as Supplier[]);
    if (partyResult.status === 'fulfilled') {
      if (cartonOnly) setCustomers(partyResult.value as Customer[]); else setParties(partyResult.value as Supplier[]);
    }
    if (productResult.status === 'fulfilled') setProducts(cartonOnly ? productResult.value.filter(item => item.category !== '纸板') : productResult.value);
    const failed = [partyResult, productResult, ...(supplierResult ? [supplierResult] : [])].find(item => item.status === 'rejected');
    setLoadError(failed?.status === 'rejected' ? message(failed.reason) : '');
    setReady(!failed);
    if (historyResult.status === 'fulfilled') { setNotes(historyResult.value.filter(note => cartonOnly ? ['production', 'carton_purchase'].includes(note.source_type || '') : !['production', 'carton_purchase'].includes(note.source_type || '')).slice(0, 8)); setHistoryError(''); }
    else setHistoryError(message(historyResult.reason));
  }, [cartonOnly]);
  useSharedRefresh(() => { void load(true); });
  useDidShow(() => { void load(); });
  const updateLine = (key: string, patch: Partial<EditableLine>) => {
    if (busy.current) return;
    setLines(current => current.map(line => line.key !== key ? line : { ...line, ...patch,
      ...(patch.delivered_qty !== undefined && !line.quantityEdited ? { quantity: patch.delivered_qty } : {}) }));
  };
  const changeParty = async (id: number | null) => {
    if (busy.current || id === (cartonOnly ? billingCustomerId : partyId)) return;
    if (lines.some(line => line.product_id || line.customer_spec_id || line.supplier_spec_id || line.goods || line.delivered_qty)) {
      const confirmation = await Taro.showModal({ title: '改变本单关联对象', content: `本单所有货物将关联新${cartonOnly ? '客户' : '供货商'}，当前货物明细将清空，请确认。`, confirmText: '确认切换' });
      if (!confirmation.confirm) return;
    }
    const nextParty = (cartonOnly ? customers : parties).find(item => item.id === id && !item.deleted_at);
    if (cartonOnly) setBillingCustomerId(id); else setPartyId(id);
    const next = newLine();
    const options = (nextParty?.specs || []).filter(item => !cartonOnly || ((item.category || (item.kind === '纸板' ? '纸板' : '纸箱')) === '纸箱'));
    setCostTotals({});
    setLines([options.length === 1 && completeGood(options[0]) ? applyGood(next, options[0], products, cartonOnly) : next]);
    setSpecDetails({});
  };
  const chooseGood = (line: EditableLine, item: PartyGood) => {
    if (busy.current) return;
    setCostTotals(current => { const next = { ...current }; delete next[line.key]; return next; });
    updateLine(line.key, applyGood(line, item, products, cartonOnly));
    setSpecDetails(current => ({ ...current, [line.key]: !item.material || !item.unit || !item.specification }));
  };
  const chooseProduct = (line: EditableLine, product: Product) => {
    if ((line.customer_spec_id || line.supplier_spec_id) && matchingProducts(line, [product], cartonOnly).length !== 1
      && line.specification && line.material && line.unit) {
      void Taro.showToast({ title: '现有商品与本行尺寸、材质或单位不一致，请重新选择', icon: 'none' }); return;
    }
    setCostTotals(current => { const next = { ...current }; delete next[line.key]; return next; });
    updateLine(line.key, applyProduct(line, product));
  };
  const confirmCreate = async (line: EditableLine) => {
    if (busy.current) return;
    if (!line.goods.trim() || !line.specification.trim() || !line.material.trim() || !line.unit.trim()) {
      void Taro.showToast({ title: '请先补齐名称、尺寸、材质和单位', icon: 'none' }); return;
    }
    const matches = matchingProducts(line, products, cartonOnly);
    if (matches.length) { void Taro.showToast({ title: '已有匹配商品，请选择现有商品', icon: 'none' }); return; }
    const confirmation = await Taro.showModal({ title: '创建并关联商品', content: `确认入库时创建“${line.goods} / ${line.specification}”，并与本行关联。请确认现有库存中没有相同商品。`, confirmText: '确认创建' });
    if (confirmation.confirm) updateLine(line.key, { create_product: true });
  };
  const save = async () => {
    if (busy.current) return;
    busy.current = true; setSaving(true);
    try {
      if (!ready || loadError) throw new Error('请先刷新商品与关联对象资料');
      if ((cartonOnly ? billingCustomerId : partyId) != null && !selectedParty) throw new Error('关联对象已停用，请重新选择');
      if (totalAmount != null && !Number.isFinite(totalAmount)) throw new Error('金额超出支持范围，请减少数量或单价');
      for (const line of lines) {
        const entered = costTotals[line.key];
        const calculated = lineAmount(line);
        if (entered?.trim() && calculated != null && Math.abs(calculated - Number(entered)) > 0.0049) throw new Error('总金额与按数量折算的金额不一致，请在货物资料中核对入库单价');
      }
      const selectedIds = lines.filter(line => line.product_id != null).map(line => line.product_id);
      if (new Set(selectedIds).size !== selectedIds.length) throw new Error('同一商品请合并数量后入库');
      const payload = lines.map((line, index) => {
        const label = `第 ${index + 1} 项`;
        if (!line.product_id && !line.create_product) throw new Error(`${label}请选择现有商品，或明确创建并关联商品`);
        if (!line.goods.trim() || !line.specification.trim() || !line.material.trim() || !line.unit.trim()) throw new Error(`${label}请补齐名称、尺寸、材质和单位`);
        if (!line.unit_price.trim() && !cartonOnly) throw new Error(`${label}请填写本次单价，未记录价格不能按零元入账`);
        if (line.customer_spec_id && !billingCustomer?.specs?.some(item => item.id === line.customer_spec_id)) throw new Error(`${label}客户货物资料已变更，请重新选择`);
        if (line.supplier_spec_id && !party?.specs?.some(item => item.id === line.supplier_spec_id)) throw new Error(`${label}供货货物资料已变更，请重新选择`);
        return { product_id: line.product_id, product_name: line.goods.trim(), goods: line.goods.trim(), specification: line.specification.trim(), material: line.material.trim(), unit: line.unit.trim(),
          quantity: numberValue(line.quantity, `${label}计划数量`, true), delivered_qty: numberValue(line.delivered_qty, `${label}实际入库数量`, true),
          unit_price: numberValue(line.unit_price || '0', `${label}单价`), ...(line.create_product ? { create_product: true } : {}),
          ...(line.customer_spec_id ? { customer_spec_id: line.customer_spec_id } : {}), ...(line.supplier_spec_id ? { supplier_spec_id: line.supplier_spec_id } : {}) };
      });
      if (payload.some(line => line.delivered_qty > line.quantity)) {
        const confirmation = await Taro.showModal({ title: '实际入库超过计划', content: '超出计划的部分也计入本次库存，金额按实际入库数量计算。是否继续？' });
        if (!confirmation.confirm) return;
      }
      if (cartonOnly && partyId != null && !party) throw new Error('供货商已停用，请重新选择');
      const note = await addDeliveryNote({ date, entered_at: `${date}T${entryTime}`, location: location.trim(), work_order_no: workOrder.trim(), ...(cartonOnly ? { billing_mode: 'on_outbound' as const } : {}),
        ...(cartonOnly ? { source_type: party ? 'carton_purchase' as const : 'production' as const, party_type: party ? 'supplier' as const : billingCustomer ? 'customer' as const : null, customer_id: billingCustomer?.id ?? null, customer_name: billingCustomer?.name || '', supplier_id: party?.id ?? null, supplier_name: party?.name || '', driver_phone: '', vehicle_no: '', freight: 0 }
          : { party_type: party ? 'supplier' as const : null, customer_id: null, customer_name: '', supplier_id: party?.id ?? null, supplier_name: party?.name || '', driver_phone: driverPhone.trim(), vehicle_no: vehicleNo.trim(), freight: numberValue(freight, '运费') }),
        remark: remark.trim(), lines: payload, operator: operator.trim() });
      invalidateProducts(); setPreview(note); setCostTotals({}); setLines([newLine()]); setSpecDetails({}); setRemark(''); setWorkOrder('');
      void Taro.showToast({ title: '入库单保存成功', icon: 'success' }); await load(true);
    } catch (error) {
      setSpecDetails(current => ({ ...current, ...Object.fromEntries(lines.filter(line => !line.goods.trim() || !line.specification.trim() || !line.material.trim() || !line.unit.trim() || (!line.unit_price.trim() && !cartonOnly)).map(line => [line.key, true])) }));
      void Taro.showToast({ title: message(error), icon: 'none' });
    }
    finally { busy.current = false; setSaving(false); }
  };
  const voidNote = async (note: DeliveryNote) => {
    if (busy.current || note.voided_at) return;
    const confirmation = await Taro.showModal({ title: '作废整张入库单', content: '将撤回全部明细的库存和本单往来金额，保留原单历史。已使用库存或已结算款项可能阻止作废。' });
    if (!confirmation.confirm) return;
    busy.current = true; setSaving(true);
    try { setPreview(await voidDeliveryNote(note.id)); invalidateProducts(); await load(true); }
    catch (error) { void Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { busy.current = false; setSaving(false); }
  };
  const setCostTotal = (line: EditableLine, value: string) => {
    setCostTotals(current => ({ ...current, [line.key]: value }));
    updateLine(line.key, { unit_price: value.trim() && Number(line.delivered_qty) > 0 ? String(roundDecimal(Number(value) / Number(line.delivered_qty), 6)) : '' });
  };
  const setReceived = (line: EditableLine, value: string) => {
    const total = costTotals[line.key];
    updateLine(line.key, { delivered_qty: value, ...(total?.trim() && Number(value) > 0 ? { unit_price: String(roundDecimal(Number(total) / Number(value), 6)) } : {}) });
  };
  const createSpecification = (line: EditableLine) => {
    if (busy.current) return;
    setCostTotals(current => { const next = { ...current }; delete next[line.key]; return next; });
    updateLine(line.key, { ...newLine(), key: line.key, quantity: line.quantity, quantityEdited: line.quantityEdited, delivered_qty: line.delivered_qty });
    setSpecDetails(current => ({ ...current, [line.key]: true }));
  };
  const chooseQuickSpec = (line: EditableLine, id: string) => {
    if (busy.current) return;
    const good = goods.find(item => 'common:' + item.id === id);
    if (good) { chooseGood(line, good); return; }
    const product = products.find(item => 'product:' + item.id === id && !item.deleted_at);
    if (!product) return;
    setCostTotals(current => { const next = { ...current }; delete next[line.key]; return next; });
    updateLine(line.key, applyProduct({ ...line, goods: '', specification: '', material: '', unit: '', customer_spec_id: null, supplier_spec_id: null }, product));
    setSpecDetails(current => ({ ...current, [line.key]: !product.specification || !product.material || !product.unit }));
  };
  return <DemoSheet title={cartonOnly ? '纸箱入库' : '库存入库'} busy={saving} testId='carton-receipt-sheet'>
    <p>选择常用货物或已有库存规格，带出货物资料，填写本次实际入库数量。</p>
    {loadError && <div role='alert' className='demo-error'>{loadError}<button type='button' className='demo-action' disabled={saving} onClick={() => void load(true)}>重新读取</button></div>}
    <DemoField label={cartonOnly ? '关联客户' : '供货商'}><select aria-label={cartonOnly ? '关联客户' : '供货商'} disabled={saving || !ready} value={(cartonOnly ? billingCustomerId : partyId) || ''} onChange={event => void changeParty(Number(event.target.value) || null)}><option value=''>{cartonOnly ? '公共备货' : '不关联供货商'}</option>{(cartonOnly ? customers : parties).filter(item => !item.deleted_at).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></DemoField>
    {lines.map((line, index) => {
      const product = line.product_id == null ? undefined : productMap.get(line.product_id);
      const amount = lineAmount(line);
      const editable = (key: 'goods' | 'material' | 'unit', label: string) => <DemoField label={label}><input type='text' aria-label={`货物 ${index + 1} ${label}`} disabled={saving} value={line[key]} onChange={event => updateLine(line.key, { [key]: event.target.value, product_id: null, create_product: false })} /></DemoField>;
      return <div key={line.key} data-testid={`inbound-line-${index + 1}`}>
        {lines.length > 1 && <DemoDetail label={`货物 ${index + 1}`}><button type='button' className='demo-action' disabled={saving} aria-label={`移除货物 ${index + 1}`} onClick={() => setLines(rows => rows.filter(item => item.key !== line.key))}>移除</button></DemoDetail>}
        <QuickSpecPicker label={`选择${cartonOnly ? '纸箱' : '入库'}规格${lines.length > 1 ? ` ${index + 1}` : ''}`}
          selected={line.goods || line.specification ? [line.goods, line.specification].filter(Boolean).join(' · ') : undefined}
          disabled={saving || !ready}
          options={[
            ...goods.map(item => ({ id: 'common:' + item.id, title: `${item.goods} · ${item.specification}`, detail: `${cartonOnly ? '客户常用' : '供货商常购'} · ${selectedParty?.name || ''} · ${item.material || '材质待补充'} · ${item.unit || '单位待补充'}` })),
            ...products.filter(item => !item.deleted_at && !lines.some(other => other.key !== line.key && other.product_id === item.id)).map(item => ({ id: 'product:' + item.id, title: `${item.name} · ${item.specification || '尺寸待补充'}`, detail: `已有库存 · ${item.material || '材质待补充'} · ${item.stock} ${item.unit || ''}`, search: item.customer_name }))
          ]}
          onSelect={id => chooseQuickSpec(line, id)} onCreate={() => createSpecification(line)} />
        {!!line.goods && <div className='demo-note' data-testid={`inbound-selected-summary-${index + 1}`}><strong>{line.goods}</strong><div>{line.specification || '尺寸待补充'} · {line.material || '材质待补充'} · {line.unit || '单位待补充'}{line.unit_price.trim() ? ` · ¥${line.unit_price}/${line.unit || '单位'}` : ' · 成本单价未记录'}</div>{product && <div>现有库存 {product.stock} {line.unit}</div>}</div>}
        {!product && !!line.goods && !!line.specification && !!line.material && !!line.unit && <button type='button' className='demo-primary demo-secondary' disabled={saving || line.create_product} onClick={() => void confirmCreate(line)}>{line.create_product ? '已确认：入库时创建并关联商品' : '创建并关联商品'}</button>}
        <DemoField label={`实际入库数量（${line.unit || '个'}）`}><input type='number' step='any' min='0' aria-label={`货物 ${index + 1} 本次完工数量`} disabled={saving} value={line.delivered_qty} onChange={event => setReceived(line, sanitizeDecimalInput(event.target.value, 6))} /></DemoField>
        <DemoField label='入库成本总金额（元，选填）'><input type='number' min='0' step='0.01' aria-label={`货物 ${index + 1} 入库成本总金额`} disabled={saving} value={costTotals[line.key] ?? (Number.isFinite(amount) && amount != null ? String(amount) : '')} onChange={event => setCostTotal(line, sanitizeDecimalInput(event.target.value, 2))} /></DemoField>
        <details className='demo-more' open={Boolean(specDetails[line.key])} onToggle={event => { const open = event.currentTarget.open; setSpecDetails(current => ({ ...current, [line.key]: open })); }}><summary>新增 / 修改货物</summary>
          <DemoField label={cartonOnly ? '客户常用货物' : '供货商常购货物'}><select aria-label={index ? `货物 ${index + 1} 常用货物` : '常用货物'} disabled={saving || !ready || !selectedParty} value={line.customer_spec_id || line.supplier_spec_id || ''} onChange={event => { const chosen = goods.find(item => String(item.id) === event.target.value); if (chosen) chooseGood(line, chosen); }}><option value=''>{selectedParty ? goods.length ? '选择常用货物' : '暂无常用货物' : `先选择${cartonOnly ? '客户' : '供货商'}`}</option>{goods.map(item => <option key={item.id} value={item.id}>{item.goods} · {item.specification}</option>)}</select></DemoField>
          <DemoField label='选择已有货物'><select aria-label={`货物 ${index + 1} 选择已有商品`} value={line.product_id || ''} disabled={saving || !ready} onChange={event => { const chosen = products.find(item => item.id === Number(event.target.value)); if (chosen) chooseProduct(line, chosen); }}><option value=''>选择已有货物</option>{products.filter(item => !item.deleted_at && !lines.some(other => other.key !== line.key && other.product_id === item.id)).map(item => <option key={item.id} value={item.id}>{item.name} · {item.specification}</option>)}</select></DemoField>
          {editable('goods', cartonOnly ? '纸箱名称（必填）' : '货物名称')}
          <DemoField label='长 × 宽 × 高 / 规格（必填）'><input type='text' aria-label={`货物 ${index + 1} 规格尺寸`} disabled={saving} value={line.specification} onChange={event => updateLine(line.key, { specification: cartonOnly ? formatSpecificationInput(event.target.value, line.specification) : event.target.value, product_id: null, create_product: false })} /></DemoField>
          <div className='demo-two'>{editable('material', '材质')}{editable('unit', '单位')}</div>
          <DemoField label='入库单价（元）'><input type='number' min='0' step='any' aria-label={`货物 ${index + 1} 入库单价`} disabled={saving} value={line.unit_price} onChange={event => { setCostTotals(current => { const next = { ...current }; delete next[line.key]; return next; }); updateLine(line.key, { unit_price: sanitizeDecimalInput(event.target.value, 6) }); }} /></DemoField>
          <DemoDetail label='入库金额（自动）'><span data-testid={`inbound-line-amount-${index + 1}`}>{amountText(amount)}</span></DemoDetail>
          {product && <p>库存 {product.stock}{line.unit} → {roundDecimal(product.stock + Math.max(0, Number(line.delivered_qty) || 0), 6)}{line.unit}</p>}
        </details>
      </div>;
    })}
    <button type='button' className='demo-action' disabled={saving} onClick={() => setLines(current => [...current, newLine()])}>＋ 再添加一项</button>
    <details className='demo-more'><summary>更多信息</summary>
      {cartonOnly && <DemoField label='供货来源'><select aria-label='供货来源' disabled={saving || !ready} value={partyId || ''} onChange={event => setPartyId(Number(event.target.value) || null)}><option value=''>自产 / 不关联供货商</option>{parties.filter(item => !item.deleted_at).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></DemoField>}
      <DemoField label='入库日期时间'><input type='datetime-local' aria-label='入库日期时间' disabled={saving} value={`${date}T${entryTime}`} max={`${localDate()}T23:59`} onChange={event => { setDate(event.target.value.slice(0, 10)); setEntryTime(event.target.value.slice(11, 16)); }} /></DemoField>
      <DemoField label='库位'><input type='text' aria-label='库位' value={location} maxLength={120} disabled={saving} onChange={event => setLocation(event.target.value)} /></DemoField>
      <div className='demo-note'>直接登记成品，不扣纸板；需要登记领料时使用“生产入库”。入库金额记成本，不增加客户应收。</div>
      <DemoField label='工单编号或采购单号'><input type='text' aria-label='工单编号或采购单号' value={workOrder} disabled={saving} onChange={event => setWorkOrder(event.target.value)} /></DemoField>
      {lines.map((line, index) => <DemoField key={line.key} label={`货物 ${index + 1} 计划数量`}><input type='number' step='any' aria-label={`货物 ${index + 1} 计划数量`} disabled={saving} value={line.quantity} onChange={event => updateLine(line.key, { quantity: sanitizeDecimalInput(event.target.value, 6), quantityEdited: true })} /></DemoField>)}
      {!cartonOnly && <><DemoField label='司机电话'><input type='tel' value={driverPhone} onChange={event => setDriverPhone(event.target.value)} /></DemoField><DemoField label='车号'><input type='text' value={vehicleNo} onChange={event => setVehicleNo(event.target.value)} /></DemoField><DemoField label='运费（元）'><input type='number' value={freight} onChange={event => setFreight(sanitizeDecimalInput(event.target.value, 2))} /></DemoField></>}
      <DemoField label='操作人'><input type='text' value={operator} onChange={event => setOperator(event.target.value)} /></DemoField><DemoField label='备注'><input type='text' aria-label='入库备注' maxLength={500} value={remark} disabled={saving} onChange={event => setRemark(event.target.value)} /></DemoField>
    </details>
    <button type='button' className='demo-primary' disabled={saving || !ready} onClick={() => void save()}>{saving ? '正在保存…' : cartonOnly ? '确认纸箱入库' : '确认入库'}</button>
    {preview && <div className='demo-card' data-testid='inbound-receipt'><h3>入库单 #{preview.id}{preview.voided_at ? ' · 已作废' : ''}</h3><p>{preview.entered_at?.replace('T', ' ') || preview.date} · {preview.customer_name || preview.supplier_name || '公共备货'}</p>{preview.lines.map((line, index) => <DemoDetail key={index} label={line.product_name || line.specification}>{line.delivered_qty} {line.unit} · {formatMoney(line.amount || 0)}</DemoDetail>)}<DemoDetail label='库位'>{preview.location || '未设库位'}</DemoDetail><DemoDetail label='供货来源'>{preview.supplier_name || '自产 / 不关联供货商'}</DemoDetail><DemoDetail label='货款合计'>{formatMoney(preview.total_amount)}</DemoDetail><button type='button' className='demo-action' onClick={() => void downloadCsv(deliveryNoteCsvUrl(preview.id), `delivery-note-${preview.id}.csv`).catch(error => Taro.showToast({ title: message(error), icon: 'none' }))}>导出 CSV</button>{!preview.voided_at && <button type='button' className='demo-action' disabled={saving} onClick={() => void voidNote(preview)}>作废整张入库单</button>}</div>}
    <details className='demo-more'><summary>最近入库单</summary><button type='button' className='demo-action' onClick={() => setHistoryOpen(true)}>读取记录</button>{historyOpen && <>{historyError && <p role='alert'>{historyError}</p>}{notes.map(note => <InboundNoteRow key={note.id} note={note} onOpen={setPreview} />)}{!notes.length && <p>暂无入库单</p>}</>}</details>
    <span className='demo-meta' data-testid='inbound-total-amount'>{amountText(totalAmount)}</span>
  </DemoSheet>;
}
