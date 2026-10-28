import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker, Button } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { addDeliveryNote, deliveryNoteCsvUrl, getCartonInboundCustomers, getDeliveryNotes, getSuppliers, voidDeliveryNote, type DeliveryNote } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { downloadCsv } from '@/services/download';
import { useSharedRefresh } from '@/services/shared-refresh';
import { localDate, numberValue, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import { formatMoney } from '@/utils/format';
import StockProductPicker from '@/components/StockProductPicker';
import StockEntryLayout from '@/components/StockEntryLayout';
import { PartySearchPanel, GoodsCards, type PartyGood } from '@/components/PartySearchPanel';
import { formatSpecificationInput } from '../print-center/specification-input';
import type { Customer, Product, Supplier } from '@/types';
import { completeGood, matchingProducts, lineAmount, draftTotal } from './entry-model';
import styles from './index.module.scss';

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
  return <View className={styles.note} onClick={() => onOpen(note)}>
    <View className={styles.noteTop}><Text>{note.work_order_no || `入库单 #${note.id}`}</Text><Text className={styles.noteAmount}>{formatMoney(note.total_amount)}</Text></View>
    <Text className={styles.noteMeta}>{note.source_type === 'production' ? `纸箱生产入库 · ${note.customer_name || '不关联客户'}` : `采购入库 · ${note.supplier_name || '不关联供货商'}`} · {note.lines.length} 项货物</Text>
    <Text className={styles.noteMeta}>{note.date} · {note.voided_at ? '已作废' : '已入库'}</Text>
  </View>;
});

export default function InboundPage() {
  const cartonOnly = useRouter().params.kind === 'carton';
  const [parties, setParties] = useState<Supplier[]>([]), [customers, setCustomers] = useState<Customer[]>([]);
  const [partyId, setPartyId] = useState<number | null>(null), [billingCustomerId, setBillingCustomerId] = useState<number | null>(null);
  const [products, setProducts] = useState<Product[]>([]), [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);
  const [date, setDate] = useState(() => localDate()), [workOrder, setWorkOrder] = useState('');
  const [driverPhone, setDriverPhone] = useState(''), [vehicleNo, setVehicleNo] = useState(''), [operator, setOperator] = useState('');
  const [freight, setFreight] = useState('0'), [remark, setRemark] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false), [ready, setReady] = useState(false), [loadError, setLoadError] = useState(''), [historyError, setHistoryError] = useState('');
  const [preview, setPreview] = useState<DeliveryNote | null>(null), [selectingKey, setSelectingKey] = useState('');
  const busy = useRef(false), sequence = useRef(0), loadedAt = useRef(0);
  const productMap = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const billingCustomer = customers.find(item => item.id === billingCustomerId && !item.deleted_at);
  const party = parties.find(item => item.id === partyId && !item.deleted_at);
  const selectedParty = cartonOnly ? billingCustomer : party;
  const goods = (selectedParty?.specs || []).filter(item => !cartonOnly || ((item.category || (item.kind === '纸板' ? '纸板' : '纸箱')) === '纸箱'));
  const activeKey = lines.some(line => line.key === selectingKey) ? selectingKey : lines[lines.length - 1]?.key;
  const totalAmount = draftTotal(lines);
  const load = useCallback(async (force = false) => {
    if (!force && Date.now() - loadedAt.current < 250) return;
    loadedAt.current = Date.now();
    const current = ++sequence.current;
    const result = await Promise.allSettled([
      cartonOnly ? getCartonInboundCustomers() : getSuppliers(), loadProducts(true), getDeliveryNotes()
    ]);
    if (current !== sequence.current) return;
    const [partyResult, productResult, historyResult] = result;
    if (partyResult.status === 'fulfilled') {
      if (cartonOnly) setCustomers(partyResult.value as Customer[]); else setParties(partyResult.value as Supplier[]);
    }
    if (productResult.status === 'fulfilled') setProducts(cartonOnly ? productResult.value.filter(item => item.category !== '纸板') : productResult.value);
    const failed = [partyResult, productResult].find(item => item.status === 'rejected');
    setLoadError(failed?.status === 'rejected' ? message(failed.reason) : '');
    setReady(!failed);
    if (historyResult.status === 'fulfilled') { setNotes(historyResult.value.filter(note => cartonOnly ? note.source_type === 'production' : note.source_type !== 'production').slice(0, 8)); setHistoryError(''); }
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
    setLines([options.length === 1 && completeGood(options[0]) ? applyGood(next, options[0], products, cartonOnly) : next]);
    setSelectingKey(next.key);
  };
  const chooseGood = (item: PartyGood) => {
    const line = lines.find(row => row.key === activeKey);
    if (line && !busy.current) updateLine(line.key, applyGood(line, item, products, cartonOnly));
  };
  const chooseProduct = (line: EditableLine, product: Product) => {
    if ((line.customer_spec_id || line.supplier_spec_id) && matchingProducts(line, [product], cartonOnly).length !== 1
      && line.specification && line.material && line.unit) {
      void Taro.showToast({ title: '现有商品与本行尺寸、材质或单位不一致，请重新选择', icon: 'none' }); return;
    }
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
      const selectedIds = lines.filter(line => line.product_id != null).map(line => line.product_id);
      if (new Set(selectedIds).size !== selectedIds.length) throw new Error('同一商品请合并数量后入库');
      const payload = lines.map((line, index) => {
        const label = `第 ${index + 1} 项`;
        if (!line.product_id && !line.create_product) throw new Error(`${label}请选择现有商品，或明确创建并关联商品`);
        if (!line.goods.trim() || !line.specification.trim() || !line.material.trim() || !line.unit.trim()) throw new Error(`${label}请补齐名称、尺寸、材质和单位`);
        if (!line.unit_price.trim()) throw new Error(`${label}请填写本次单价，未记录价格不能按零元入账`);
        if (line.customer_spec_id && !billingCustomer?.specs?.some(item => item.id === line.customer_spec_id)) throw new Error(`${label}客户货物资料已变更，请重新选择`);
        if (line.supplier_spec_id && !party?.specs?.some(item => item.id === line.supplier_spec_id)) throw new Error(`${label}供货货物资料已变更，请重新选择`);
        return { product_id: line.product_id, product_name: line.goods.trim(), goods: line.goods.trim(), specification: line.specification.trim(), material: line.material.trim(), unit: line.unit.trim(),
          quantity: numberValue(line.quantity, `${label}计划数量`, true), delivered_qty: numberValue(line.delivered_qty, `${label}实际入库数量`, true),
          unit_price: numberValue(line.unit_price, `${label}单价`), ...(line.create_product ? { create_product: true } : {}),
          ...(line.customer_spec_id ? { customer_spec_id: line.customer_spec_id } : {}), ...(line.supplier_spec_id ? { supplier_spec_id: line.supplier_spec_id } : {}) };
      });
      if (payload.some(line => line.delivered_qty > line.quantity)) {
        const confirmation = await Taro.showModal({ title: '实际入库超过计划', content: '超出计划的部分也计入本次库存，金额按实际入库数量计算。是否继续？' });
        if (!confirmation.confirm) return;
      }
      const note = await addDeliveryNote({ date, work_order_no: workOrder.trim(), ...(cartonOnly ? { billing_mode: 'on_outbound' as const } : {}),
        ...(cartonOnly ? { source_type: 'production' as const, party_type: billingCustomer ? 'customer' as const : null, customer_id: billingCustomer?.id ?? null, customer_name: billingCustomer?.name || '', supplier_id: null, supplier_name: '', driver_phone: '', vehicle_no: '', freight: 0 }
          : { party_type: party ? 'supplier' as const : null, customer_id: null, customer_name: '', supplier_id: party?.id ?? null, supplier_name: party?.name || '', driver_phone: driverPhone.trim(), vehicle_no: vehicleNo.trim(), freight: numberValue(freight, '运费') }),
        remark: remark.trim(), lines: payload, operator: operator.trim() });
      invalidateProducts(); setPreview(note); setLines([newLine()]); setRemark(''); setWorkOrder('');
      void Taro.showToast({ title: '入库单保存成功', icon: 'success' }); await load(true);
    } catch (error) { void Taro.showToast({ title: message(error), icon: 'none' }); }
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
  return <StockEntryLayout title={cartonOnly ? '纸箱生产入库' : '采购入库'} subtitle='选择已有对象和常用货物，核对资料，填写本次数量。' onRefresh={() => { void load(true); }} busy={saving}>
    <View className={styles.page}>
      {cartonOnly && <Text className={styles.hint}>入库金额记成本；关联客户用于区分货物，客户出库后再生成应收。</Text>}
      {loadError && <View role='alert' className={styles.error}>{loadError}<Button className={styles.textButton} disabled={saving} onClick={() => { void load(true); }}>重新读取</Button></View>}
      <View className={styles.field}><Text className={styles.fieldLabel}>{cartonOnly ? '客户（选填）' : '供货商（选填）'}</Text>
        <PartySearchPanel partyType={cartonOnly ? 'customer' : 'supplier'} parties={cartonOnly ? customers : parties} selectedId={cartonOnly ? billingCustomerId : partyId} disabled={saving || !ready} onSelect={item => { void changeParty(item?.id ?? null); }} />
        <Text className={styles.hint}>{selectedParty ? `本单关联：${selectedParty.name}。选择其他对象会改变整张入库单的关联。` : `不关联${cartonOnly ? '客户' : '供货商'}，只增加库存，不生成往来款。`}</Text>
      </View>
      {selectedParty && <View className={styles.field}><Text className={styles.fieldLabel}>{cartonOnly ? '常用销售资料' : '常用采购资料'} · 带入货物 {Math.max(1, lines.findIndex(line => line.key === activeKey) + 1)}</Text>
        <GoodsCards items={goods} onSelect={chooseGood} disabled={saving || !ready} />
        {!goods.length && <Text className={styles.hint}>请在{cartonOnly ? '客户管理' : '供货商管理'}补充常用货物，或选择下方已有商品。</Text>}
      </View>}
      {lines.map((line, index) => {
        const product = line.product_id == null ? undefined : productMap.get(line.product_id);
        const amount = lineAmount(line);
        const editable = (key: 'goods' | 'material' | 'unit', label: string) => <View className={styles.field}><Text className={styles.fieldLabel}>{label}</Text><Input aria-label={`货物 ${index + 1} ${label}`} disabled={saving} className={styles.input} value={line[key]} onInput={event => updateLine(line.key, { [key]: event.detail.value, product_id: null, create_product: false })} /></View>;
        return <View className={styles.lineCard} key={line.key} data-testid={`inbound-line-${index + 1}`}>
          <View className={styles.lineHead}><Text className={styles.fieldLabel}>货物 {index + 1}</Text><Button disabled={saving} className={styles.textButton} onClick={() => setSelectingKey(line.key)}>选择常用货物</Button>{lines.length > 1 && <Button aria-label={`移除货物 ${index + 1}`} disabled={saving} className={styles.remove} onClick={() => setLines(current => current.filter(item => item.key !== line.key))}>移除</Button>}</View>
          <StockProductPicker products={products} value={line.product_id} disabled={saving || !ready} excluded={lines.filter(item => item.key !== line.key).map(item => item.product_id || 0)} onSelect={item => chooseProduct(line, item)} />
          {editable('goods', '货物名称')}
          <View className={styles.field}><Text className={styles.fieldLabel}>规格尺寸</Text><Input aria-label={`货物 ${index + 1} 规格尺寸`} disabled={saving} className={styles.input} value={line.specification} onInput={event => updateLine(line.key, { specification: cartonOnly ? formatSpecificationInput(event.detail.value, line.specification) : event.detail.value, product_id: null, create_product: false })} /></View>
          <View className={styles.grid}>{editable('material', '材质')}{editable('unit', '单位')}</View>
          {!product && line.goods && <View className={styles.field}><Text className={styles.hint}>请选择对应现有商品。未找到时可明确创建并关联，系统不会自动建商品。</Text><Button disabled={saving || line.create_product} className={styles.addLine} onClick={() => { void confirmCreate(line); }}>{line.create_product ? '已确认：入库时创建并关联商品' : '创建并关联商品'}</Button></View>}
          <View className={styles.grid}>
            <View><Text className={styles.fieldLabel}>{cartonOnly ? '本次完工数量' : '实际入库数量'}（{line.unit || '单位未记录'}）</Text><Input aria-label={`货物 ${index + 1} ${cartonOnly ? '本次完工数量' : '实际入库数量'}`} disabled={saving} className={styles.input} type='digit' value={line.delivered_qty} onInput={event => updateLine(line.key, { delivered_qty: sanitizeDecimalInput(event.detail.value, 6) })} /></View>
            <View><Text className={styles.fieldLabel}>{cartonOnly ? '入库单价' : '采购单价'}（元）</Text><Input aria-label={`货物 ${index + 1} ${cartonOnly ? '入库单价' : '单价'}`} disabled={saving} className={styles.input} type='digit' value={line.unit_price} onInput={event => updateLine(line.key, { unit_price: sanitizeDecimalInput(event.detail.value, 2) })} /></View>
          </View>
          <View className={styles.amountNote} data-testid={`inbound-line-amount-${index + 1}`}><Text>入库金额（自动）</Text><Text>{amountText(amount)}</Text></View>
          {!line.unit_price && <Text className={styles.hint}>价格未记录，单价与金额保持空白；确认入库前请填写本次单价。</Text>}
          {product && <Text className={styles.stockNote}>库存 {product.stock}{line.unit} → {roundDecimal(product.stock + Math.max(0, Number(line.delivered_qty) || 0), 6)}{line.unit}</Text>}
        </View>;
      })}
      <Button disabled={saving} className={styles.addLine} onClick={() => { const line = newLine(); setLines(current => [...current, line]); setSelectingKey(line.key); }}>＋ 再添加一项</Button>
      <View className={styles.field}><Text className={styles.fieldLabel}>业务日期</Text><Picker aria-label='业务日期' disabled={saving} mode='date' value={date} onChange={event => setDate(event.detail.value)}><View className={styles.picker}>{date}<Text>⌄</Text></View></Picker></View>
      <Button disabled={saving} className={styles.detailsToggle} aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>更多信息<Text>{detailsOpen ? '收起 −' : '展开 ＋'}</Text></Button>
      {detailsOpen && <View className={styles.detailsBody}>
        <View className={styles.field}><Text className={styles.fieldLabel}>{cartonOnly ? '生产工单编号' : '采购单号'}</Text><Input aria-label='工单编号或采购单号' disabled={saving} className={styles.input} value={workOrder} onInput={event => setWorkOrder(event.detail.value)} /></View>
        {lines.map((line, index) => <View className={styles.planField} key={line.key}><Text className={styles.fieldLabel}>货物 {index + 1} 计划数量</Text><Input aria-label={`货物 ${index + 1} 计划数量`} disabled={saving} className={styles.input} type='digit' value={line.quantity} onInput={event => updateLine(line.key, { quantity: sanitizeDecimalInput(event.detail.value, 6), quantityEdited: true })} /><Text className={styles.hint}>默认与实际入库数量一致，超收或少收时可单独填写。</Text></View>)}
        {!cartonOnly && <View className={styles.row}><View><Text className={styles.fieldLabel}>司机电话</Text><Input disabled={saving} className={styles.input} value={driverPhone} onInput={event => setDriverPhone(event.detail.value)} /></View><View><Text className={styles.fieldLabel}>车号</Text><Input disabled={saving} className={styles.input} value={vehicleNo} onInput={event => setVehicleNo(event.detail.value)} /></View></View>}
        <View className={styles.row}><View><Text className={styles.fieldLabel}>操作人</Text><Input disabled={saving} className={styles.input} value={operator} onInput={event => setOperator(event.detail.value)} /></View>{!cartonOnly && <View><Text className={styles.fieldLabel}>运费（元）</Text><Input disabled={saving} className={styles.input} type='digit' value={freight} onInput={event => setFreight(sanitizeDecimalInput(event.detail.value, 2))} /></View>}</View>
        {!cartonOnly && <Text className={styles.hint}>运费单独记录，不计入货款或往来账单。</Text>}
        <View className={styles.field}><Text className={styles.fieldLabel}>备注</Text><Input aria-label='入库备注' disabled={saving} className={styles.input} maxlength={500} value={remark} onInput={event => setRemark(event.detail.value)} /></View>
      </View>}
      <View className={styles.total}><Text>{lines.length} 项货物 · 仅合计已填价格和数量</Text><Text data-testid='inbound-total-amount'>{cartonOnly ? '入库金额合计' : '货款合计'} {amountText(totalAmount)}</Text></View>
      <Button disabled={saving || !ready} className={styles.saveButton} onClick={() => { void save(); }}>{saving ? '正在保存…' : '确认入库'}</Button>
      {preview && <View className={styles.preview}><View className={styles.previewTop}><Text className={styles.previewTitle}>入库单 #{preview.id}{preview.voided_at ? ' · 已作废' : ''}</Text><Button className={styles.textButton} onClick={() => setPreview(null)}>收起</Button></View>
        <Text className={styles.previewMeta}>{preview.date} · {preview.customer_name || preview.supplier_name || '不关联对象'}</Text>
        {preview.lines.map((line, index) => <View className={styles.previewLine} key={index}><View><Text>{line.product_name}</Text><Text>{line.specification} · {line.material}</Text></View><View><Text>{line.delivered_qty}{line.unit}</Text><Text>{formatMoney(line.amount || 0)}</Text></View></View>)}
        <Text className={styles.previewTotal}>货款合计 {formatMoney(preview.total_amount)}</Text>
        <Button className={styles.export} onClick={() => { void downloadCsv(deliveryNoteCsvUrl(preview.id), `delivery-note-${preview.id}.csv`).catch(error => Taro.showToast({ title: message(error), icon: 'none' })); }}>导出 CSV</Button>
        {!preview.voided_at && <Button disabled={saving} className={styles.voidButton} onClick={() => { void voidNote(preview); }}>作废整张入库单</Button>}
      </View>}
      <Button className={styles.historyToggle} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>最近入库单<Text>{historyOpen ? '收起 −' : '查看 ＋'}</Text></Button>
      {historyOpen && <>{historyError && <View className={styles.error}>{historyError}</View>}{!notes.length ? <View className={styles.empty}>暂无入库单</View> : notes.map(note => <InboundNoteRow key={note.id} note={note} onOpen={setPreview} />)}</>}
    </View>
  </StockEntryLayout>;
}
