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
import type { Customer, Product } from '@/types';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';

type EditableLine = { key: string; product_id: number | null; specification: string; quantity: string; quantityEdited: boolean; unit_price: string; delivered_qty: string };
const newLine = (): EditableLine => ({ key: `${Date.now()}-${Math.random()}`, product_id: null, specification: '', quantity: '1', quantityEdited: false, unit_price: '0', delivered_qty: '1' });
const applyProduct = (line: EditableLine, product: Product): EditableLine => ({ ...line, product_id: product.id, specification: product.specification || '', unit_price: String(product.price) });
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

type InboundNoteRowProps = { note: DeliveryNote; onOpen: (note: DeliveryNote) => void };
const InboundNoteRow = React.memo(function InboundNoteRow({ note, onOpen }: InboundNoteRowProps) {
  const isCustomerNote = note.party_type === 'customer' || (note.party_type == null && note.customer_id != null);
  const partyName = isCustomerNote ? note.customer_name : note.supplier_name;
  const partyLabel = isCustomerNote ? '客户' : '供货商';
  return <View className={styles.note} onClick={() => onOpen(note)}>
    <View className={styles.noteTop}><Text>{note.work_order_no || `入库单 #${note.id}`}</Text><Text className={styles.noteAmount}>{formatMoney(note.total_amount)}</Text></View>
    <Text className={styles.noteMeta}>{partyLabel}：{partyName || `未关联${partyLabel}`} · {note.lines.length} 项商品</Text>
    <Text className={styles.noteMeta}>{note.date} · {note.voided_at ? '已作废' : '已入库'}</Text>
  </View>;
});

export default function InboundPage() {
  const cartonOnly = useRouter().params.kind === 'carton';
  const [parties, setParties] = useState<Customer[]>([]);
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
  const loadInboundData = useCallback(async () => {
    lastLoadAt.current = Date.now();
    const [loadedParties, p, n] = await Promise.all([cartonOnly ? getCustomers() : getSuppliers(), loadProducts(true), getDeliveryNotes()]);
    return { parties: loadedParties, products: cartonOnly ? p.filter(item => item.category !== '纸板' && (item.category === '纸箱' || /\d\s*[×xX*]\s*\d.*[×xX*]/.test(item.specification || ''))) : p, notes: n.slice(0, 8) };
  }, [cartonOnly]);
  const remote = useRemoteData(loadInboundData, { parties: [] as Customer[], products: [] as Product[], notes: [] as DeliveryNote[] });
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
    if (!remote.loading && remote.ready) { setParties(remote.data.parties); setProducts(remote.data.products); setNotes(remote.data.notes); setReady(true); setLoadError(''); }
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
      return blank < 0 ? [...current, applyProduct(newLine(), product)] : current.map((line, index) => index === blank ? applyProduct(line, product) : line);
    });
    setTransitId(null);
  }, [transitId, productMap, ready, saving]);
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
  const save = async () => {
    if (busy.current) return;
    // Hold the same lock while validating and awaiting over-receipt confirmation.
    // A second tap must not open another confirmation and submit the same draft.
    busy.current = true; setSaving(true);
    try {
      if (!Number.isFinite(totalAmount)) throw new Error('金额超出支持范围，请减少数量或单价');
      if (!ready || loadError) throw new Error(`请先刷新商品与${cartonOnly ? '客户' : '供应商'}数据`);
      if (partyId && !party) throw new Error(`${cartonOnly ? '客户' : '供货商'}已停用，请重新选择`);
      if (new Set(lines.map(line => line.product_id)).size !== lines.length) throw new Error('同一商品不能重复，请合并数量');
      const payload = lines.map((line, index) => {
        const product = line.product_id == null ? undefined : productMap.get(line.product_id);
        if (!product) throw new Error(`第 ${index + 1} 行请选择有效商品`);
        return { product_id: product.id, product_name: product.name, specification: line.specification.trim(), unit: product.unit, quantity: numberValue(line.quantity, `第 ${index + 1} 行计划数量`, true), delivered_qty: numberValue(line.delivered_qty, `第 ${index + 1} 行实际入库数量`), unit_price: numberValue(line.unit_price, `第 ${index + 1} 行单价`) };
      });
      const overReceived = payload.filter(line => line.delivered_qty > line.quantity);
      if (overReceived.length) {
        const names = overReceived.map(line => `${line.product_name}（计划 ${line.quantity}，实收 ${line.delivered_qty}）`).join('；');
        const confirmation = await Taro.showModal({ title: '实际入库超过计划', content: `${names}。超收部分会一并计入库存和应付，是否继续？`, confirmText: '继续入库', cancelText: '返回修改' });
        if (!confirmation.confirm) return;
      }
      const freightValue = numberValue(freight, '运费');
      const note = await addDeliveryNote({ date, work_order_no: workOrder.trim(), party_type: cartonOnly ? 'customer' : 'supplier', customer_id: cartonOnly ? partyId : null, customer_name: cartonOnly ? party?.name || '' : '', supplier_id: cartonOnly ? null : partyId, supplier_name: cartonOnly ? '' : party?.name || '', driver_phone: driverPhone.trim(), vehicle_no: vehicleNo.trim(), freight: freightValue, remark: remark.trim(), lines: payload, operator: operator.trim() });
      invalidateProducts();
      setPreview(note); setWorkOrder(''); setDriverPhone(''); setVehicleNo(''); setOperator(''); setFreight('0'); setRemark(''); setPartyId(null); setLines([newLine()]);
      Taro.showToast({ title: '入库单保存成功', icon: 'success' }); await load();
    } catch (error) { Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { busy.current = false; setSaving(false); }
  };
  const voidNote = async (note: DeliveryNote) => {
    if (busy.current || note.voided_at) return;
    busy.current = true; setSaving(true);
    try {
      const confirmation = await Taro.showModal({ title: '作废整张入库单', content: '将撤回全部明细的库存和应付款，保留原单历史。已使用的库存或已结算款项可能阻止作废。' });
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
  return <StockEntryLayout title={cartonOnly ? '纸箱入库' : '入库'} subtitle='选货物，填数量，确认保存。' onRefresh={() => { void load(true); }} busy={saving}>
    <View className={styles.page}>
      {loadError && <View role='alert' className={styles.error}>{loadError}<Button disabled={saving} className={styles.textButton} onClick={() => { void load(true); }}>重新读取</Button></View>}
      <View className={styles.field}>
        <Text className={styles.fieldLabel}>{cartonOnly ? '客户' : '供货商'}</Text>
        <Picker aria-label={cartonOnly ? '选择客户' : '选择供货商'} disabled={saving} range={[`不关联${cartonOnly ? '客户' : '供货商'}`, ...parties.map(item => item.name)]} value={Math.max(0, parties.findIndex(item => item.id === partyId) + 1)} onChange={e => { const index = Number(e.detail.value); setPartyId(index ? parties[index - 1]?.id || null : null); }}><View className={styles.picker}>{party?.name || (partyId ? `${cartonOnly ? '客户' : '供货商'}已停用，请重新选择` : `选择${cartonOnly ? '客户' : '供货商'}`)}<Text>⌄</Text></View></Picker>
      </View>
      {lines.map((line, index) => {
        const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
        const unit = selected?.unit || '单位';
        return <View className={styles.lineCard} key={line.key}>
          <View className={styles.lineHead}><Text className={styles.fieldLabel}>{lines.length > 1 ? `货物 ${index + 1}` : '货物名称'}</Text>{lines.length > 1 && <Button disabled={saving} aria-label={`移除货物 ${index + 1}`} className={styles.remove} onClick={() => { if (!busy.current) setLines(current => current.filter(item => item.key !== line.key)); }}>移除</Button>}</View>
          <StockProductPicker products={products} value={line.product_id} disabled={saving} excluded={lines.filter(item => item.key !== line.key).map(item => item.product_id || 0)} onSelect={product => updateLine(line.key, applyProduct(line, product))} />
          <View className={styles.field}><Text className={styles.fieldLabel}>规格尺寸</Text><Input aria-label={`货物 ${index + 1} 规格尺寸`} disabled={saving} className={styles.input} value={line.specification} onInput={e => updateLine(line.key, { specification: cartonOnly ? formatSpecificationInput(e.detail.value, line.specification) : e.detail.value })} /></View>
          <View className={styles.grid}>
            <View><Text className={styles.fieldLabel}>入库数量（{unit}）</Text><Input aria-label={`货物 ${index + 1} 实际入库数量`} disabled={saving} className={styles.input} type='digit' value={line.delivered_qty} onInput={e => updateLine(line.key, { delivered_qty: sanitizeDecimalInput(e.detail.value, 6) })} /></View>
            <View><Text className={styles.fieldLabel}>单价（元/{unit}）</Text><Input aria-label={`货物 ${index + 1} 单价`} disabled={saving} className={styles.input} type='digit' value={line.unit_price} onInput={e => updateLine(line.key, { unit_price: sanitizeDecimalInput(e.detail.value, 2) })} /></View>
          </View>
          {selected && <Text className={styles.stockNote}>库存 {selected.stock}{unit} → {roundDecimal(selected.stock + Math.max(0, Number(line.delivered_qty) || 0), 6)}{unit}</Text>}
          {line.delivered_qty.trim() && line.unit_price.trim() && !Number.isFinite(calculated[index].amount) && <View role='alert' className={styles.error}>金额超出支持范围，请减少数量或单价</View>}
        </View>;
      })}
      <Button disabled={saving} className={styles.addLine} onClick={() => { if (!busy.current) setLines(current => [...current, newLine()]); }}>＋ 添加货物</Button>
      <View className={styles.field}><Text className={styles.fieldLabel}>业务日期</Text><Picker aria-label='业务日期' disabled={saving} mode='date' value={date} onChange={e => setDate(e.detail.value)}><View className={styles.picker}>{date}<Text>⌄</Text></View></Picker></View>
      <Button disabled={saving} className={styles.detailsToggle} aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}><Text>更多信息</Text><Text>{detailsOpen ? '收起 −' : '展开 ＋'}</Text></Button>
      {detailsOpen && <View className={styles.detailsBody}>
        <View className={styles.field}><Text className={styles.fieldLabel}>工单编号 / 采购单号</Text><Input aria-label='工单编号或采购单号' disabled={saving} className={styles.input} value={workOrder} onInput={e => setWorkOrder(e.detail.value)} /></View>
        {lines.map((line, index) => {
          const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
          const [length, width] = dimensions(line.specification, selected);
          return <View key={line.key} className={styles.planField}><Text className={styles.fieldLabel}>{lines.length > 1 ? `货物 ${index + 1} · ` : ''}计划数量（{selected?.unit || '单位'}）</Text><Input aria-label={`货物 ${index + 1} 计划数量`} disabled={saving} className={styles.input} type='digit' value={line.quantity} onInput={e => updateLine(line.key, { quantity: sanitizeDecimalInput(e.detail.value, 6), quantityEdited: true })} /><Text className={styles.hint}>{line.quantityEdited ? '已手动设置计划数量，后续修改实收数不会覆盖。' : '默认与实收数量一致，有超收或少收时可分别填写。'}</Text><Text className={styles.hint}>{length && width ? `实际面积 ${calculated[index].square.toFixed(4)} ㎡，按 ${length}×${width} mm × 实收数量计算` : '未设置有效长宽，面积不统计；库存和金额正常计算'}</Text></View>;
        })}
        <View className={styles.row}>
          <View><Text className={styles.fieldLabel}>司机电话</Text><Input aria-label='司机电话' disabled={saving} className={styles.input} value={driverPhone} onInput={e => setDriverPhone(e.detail.value)} /></View>
          <View><Text className={styles.fieldLabel}>车号</Text><Input aria-label='车号' disabled={saving} className={styles.input} value={vehicleNo} onInput={e => setVehicleNo(e.detail.value)} /></View>
        </View>
        <View className={styles.row}>
          <View><Text className={styles.fieldLabel}>操作人</Text><Input aria-label='操作人' disabled={saving} className={styles.input} value={operator} onInput={e => setOperator(e.detail.value)} /></View>
          <View><Text className={styles.fieldLabel}>运费（元）</Text><Input aria-label='运费' disabled={saving} className={styles.input} type='digit' value={freight} onInput={e => setFreight(sanitizeDecimalInput(e.detail.value, 2))} /></View>
        </View>
        <Text className={styles.hint}>运费单独记录，不计入货款或往来账单。</Text>
        <View className={styles.field}><Text className={styles.fieldLabel}>备注</Text><Input aria-label='入库备注' disabled={saving} className={styles.input} maxlength={500} value={remark} onInput={e => setRemark(e.detail.value)} /></View>
        <Text className={styles.hint}>{cartonOnly ? (party ? '本单货款保存在客户关联入库单中，不增加客户应收。' : '未关联客户时，只更新库存并记录入库单。') : (party ? '本单货款计入所选供货商应付账单。' : '未关联供货商时，只更新库存，不登记供货商应付。')}</Text>
      </View>}
      <View className={styles.total}><Text>{lines.length} 项货物</Text><Text>货款合计 {formatMoneyPreview(totalAmount)}</Text></View>
      <Button disabled={saving || !ready} className={styles.saveButton} onClick={() => { void save(); }}>{saving ? '正在保存…' : '确认入库'}</Button>
      {preview && <View className={styles.preview}>
        <View className={styles.previewTop}><Text className={styles.previewTitle}>入库单 #{preview.id}{preview.voided_at ? ' · 已作废' : ''}</Text><Button className={styles.textButton} onClick={() => setPreview(null)}>收起</Button></View>
        <Text className={styles.previewMeta}>日期：{preview.date}　工单：{preview.work_order_no || '未填写'}</Text><Text className={styles.previewMeta}>{preview.party_type === 'customer' || (preview.party_type == null && preview.customer_id != null) ? `客户：${preview.customer_name || '未关联'}` : `供货商：${preview.supplier_name || '未关联'}`}　操作人：{preview.operator || '未填写'}</Text>
        {preview.lines.map((line, index) => <View className={styles.previewLine} key={index}><View><Text>{line.product_name}</Text><Text className={styles.hint}>{line.specification}</Text></View><View><Text>实收 {line.delivered_qty}{line.unit}</Text><Text className={styles.hint}>计划 {line.quantity}{line.unit}</Text><Text>{formatMoney(line.amount || 0)}</Text><Text className={styles.hint}>{Number(line.square_meters || 0).toFixed(2)} ㎡</Text></View></View>)}
        <Text className={styles.previewTotal}>货款 {formatMoney(preview.total_amount)} · 实际面积 {preview.total_square_meters.toFixed(4)} ㎡</Text><Text className={styles.previewMeta}>运费 {formatMoney(Number(preview.freight || 0))}（单独记录）</Text>
        <Button disabled={saving} className={styles.export} onClick={() => { void exportCsv(preview); }}>导出 CSV</Button>{!preview.voided_at && <Button disabled={saving} className={styles.voidButton} onClick={() => { void voidNote(preview); }}>作废整张入库单</Button>}
      </View>}
      <Button disabled={saving} className={styles.historyToggle} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><Text>最近入库单</Text><Text>{historyOpen ? '收起 −' : '查看 ＋'}</Text></Button>
      {historyOpen && (!notes.length ? <View className={styles.empty}>暂无入库单</View> : notes.map(note => <InboundNoteRow key={note.id} note={note} onOpen={openPreview} />))}
      {detailsOpen && <Text className={styles.hint}>本单实际面积 {totalSquare.toFixed(4)} ㎡</Text>}
    </View>
  </StockEntryLayout>;
}
