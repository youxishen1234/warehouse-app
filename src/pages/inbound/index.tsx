import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { addDeliveryNote, deliveryNoteCsvUrl, getDeliveryNotes, getSuppliers, voidDeliveryNote, type DeliveryNote } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { downloadCsv } from '@/services/download';
import { useSharedRefresh } from '@/services/shared-refresh';
import { dimensions, localDate, numberValue, previewAmount, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import { formatMoney, formatMoneyPreview } from '@/utils/format';
import StockProductPicker from '@/components/StockProductPicker';
import type { Customer, Product } from '@/types';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';

type EditableLine = { key: string; product_id: number | null; specification: string; quantity: string; unit_price: string; delivered_qty: string };
const newLine = (): EditableLine => ({ key: `${Date.now()}-${Math.random()}`, product_id: null, specification: '', quantity: '1', unit_price: '0', delivered_qty: '1' });
const applyProduct = (line: EditableLine, product: Product): EditableLine => ({ ...line, product_id: product.id, specification: product.specification || '', unit_price: String(product.price) });
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

type InboundNoteRowProps = { note: DeliveryNote; onOpen: (note: DeliveryNote) => void };
const InboundNoteRow = React.memo(function InboundNoteRow({ note, onOpen }: InboundNoteRowProps) {
  return <View className={styles.note} onClick={() => onOpen(note)}>
    <Text>{note.date} ? {note.work_order_no || `??? #${note.id}`} ? {note.voided_at ? '???' : '???'}</Text>
    <Text>{note.supplier_name || '??????'} ? {note.lines.length} ? ? {formatMoney(note.total_amount)}</Text>
  </View>;
});

export default function InboundPage() {
  const [suppliers, setSuppliers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [date, setDate] = useState(() => localDate());
  const [workOrder, setWorkOrder] = useState('');
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [operator, setOperator] = useState('');
  const [freight, setFreight] = useState('0');
  const [remark, setRemark] = useState('');
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
  const remote = useRemoteData(async () => {
    const startedAt = Date.now();
    if (startedAt - lastLoadAt.current < 250) return { suppliers: [], products: [], notes: [] };
    lastLoadAt.current = startedAt;
    const [s, p, n] = await Promise.all([getSuppliers(), loadProducts(true), getDeliveryNotes()]);
    return { suppliers: s, products: p, notes: n.slice(0, 8) };
  }, { suppliers: [] as Customer[], products: [] as Product[], notes: [] as DeliveryNote[] });
  const load = remote.reload;
  // useRemoteData owns loadSequence/requestId; if (current !== loadSequence.current), stale responses are discarded.
  useEffect(() => {
    if (!remote.loading && remote.ready) { setSuppliers(remote.data.suppliers); setProducts(remote.data.products); setNotes(remote.data.notes); setReady(true); setLoadError(''); }
    if (remote.loadError) { setReady(false); setLoadError(remote.loadError); }
  }, [remote.loading, remote.ready, remote.loadError, remote.data]);
  useSharedRefresh(load);
  useDidShow(() => {
    const firstShow = !didShowOnce.current;
    didShowOnce.current = true;
    if (!firstShow || Date.now() - lastLoadAt.current >= 250) void load();
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
  const supplier = suppliers.find(item => item.id === supplierId);
  const openPreview = useCallback((note: DeliveryNote) => setPreview(note), []);
  const calculated = useMemo(() => lines.map(line => {
    const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
    const [length, width] = dimensions(line.specification, selected);
    const delivered = Math.max(0, Number(line.delivered_qty) || 0);
    return { square: roundDecimal(delivered * length * width / 1000000, 4), amount: previewAmount(line.delivered_qty, line.unit_price) };
  }), [lines, productMap]);
  const totalSquare = useMemo(() => roundDecimal(calculated.reduce((sum, item) => sum + item.square, 0), 4), [calculated]);
  const totalAmount = useMemo(() => calculated.every(item => Number.isFinite(item.amount)) ? roundDecimal(calculated.reduce((sum, item) => sum + item.amount, 0), 2) : Number.NaN, [calculated]);
  const updateLine = (key: string, patch: Partial<EditableLine>) => { if (!busy.current) setLines(current => current.map(line => line.key === key ? { ...line, ...patch } : line)); };
  const save = async () => {
    if (busy.current) return;
    try {
      if (!Number.isFinite(totalAmount)) throw new Error('金额超出支持范围，请减少数量或单价');
      if (!ready || loadError) throw new Error('请先刷新商品与供应商数据');
      if (supplierId && !supplier) throw new Error('供应商已停用，请重新选择');
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
      busy.current = true; setSaving(true);
      const note = await addDeliveryNote({ date, work_order_no: workOrder.trim(), supplier_id: supplierId, supplier_name: supplier?.name || '', driver_phone: driverPhone.trim(), vehicle_no: vehicleNo.trim(), freight: freightValue, remark: remark.trim(), lines: payload, operator: operator.trim() });
      invalidateProducts();
      setPreview(note); setWorkOrder(''); setDriverPhone(''); setVehicleNo(''); setOperator(''); setFreight('0'); setRemark(''); setSupplierId(null); setLines([newLine()]);
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
  return <ScrollView scrollY className={styles.page} refresherEnabled={false} onRefresherRefresh={() => load()}>
    <Text className={styles.title}>入库开单</Text><Text className={styles.subTitle}>选择已有商品，按实际入库数量更新库存与货款</Text>
    {loadError && <View className={styles.error} onClick={() => load()}>{loadError} · 点击重试</View>}
    <View className={styles.card}>
      <View className={styles.row}>
        <View className={styles.half}><Text>日期</Text><Picker disabled={saving} mode='date' value={date} onChange={e => setDate(e.detail.value)}><View className={styles.picker}>{date}</View></Picker></View>
        <View className={styles.half}><Text>工单编号 / 采购单号</Text><Input disabled={saving} className={styles.input} placeholder='选填单号' value={workOrder} onInput={e => setWorkOrder(e.detail.value)} /></View>
      </View>
      <Text>供应商</Text>
      <Picker disabled={saving} range={['不关联供应商', ...suppliers.map(item => item.name)]} value={Math.max(0, suppliers.findIndex(item => item.id === supplierId) + 1)} onChange={e => { const index = Number(e.detail.value); setSupplierId(index ? suppliers[index - 1]?.id || null : null); }}><View className={styles.picker}>{supplier?.name || (supplierId ? '供应商已停用，请重新选择' : '选择供应商（选填）')}</View></Picker>
      <Text className={styles.hint}>{supplier ? '本单货款计入该供应商应付' : '未关联供应商时，仅更新库存，不登记供应商应付'}</Text>
      <View className={styles.row}>
        <View className={styles.half}><Text>司机电话</Text><Input disabled={saving} className={styles.input} value={driverPhone} onInput={e => setDriverPhone(e.detail.value)} /></View>
        <View className={styles.half}><Text>车号</Text><Input disabled={saving} className={styles.input} value={vehicleNo} onInput={e => setVehicleNo(e.detail.value)} /></View>
      </View>
      <View className={styles.row}>
        <View className={styles.half}><Text>操作人</Text><Input disabled={saving} className={styles.input} placeholder='选填，默认当前操作账号' value={operator} onInput={e => setOperator(e.detail.value)} /></View>
        <View className={styles.half}><Text>运费（元）</Text><Input disabled={saving} className={styles.input} type='digit' value={freight} onInput={e => setFreight(sanitizeDecimalInput(e.detail.value, 2))} /></View>
      </View>
      <Text className={styles.hint}>运费单独记录，不计入货款和供应商应付</Text><Text>备注</Text><Input disabled={saving} className={styles.input} maxlength={500} value={remark} onInput={e => setRemark(e.detail.value)} />
    </View>
    <Text className={styles.section}>入库明细</Text>
    {lines.map((line, index) => {
      const selected = line.product_id == null ? undefined : productMap.get(line.product_id);
      const unit = selected?.unit || '单位'; const [length, width] = dimensions(line.specification, selected);
      return <View className={styles.lineCard} key={line.key}>
        <View className={styles.lineHead}><Text>第 {index + 1} 行</Text>{lines.length > 1 && <Text className={styles.remove} onClick={() => { if (!busy.current) setLines(current => current.filter(item => item.key !== line.key)); }}>移除</Text>}</View>
        <StockProductPicker products={products} value={line.product_id} disabled={saving} excluded={lines.filter(item => item.key !== line.key).map(item => item.product_id || 0)} onSelect={product => updateLine(line.key, applyProduct(line, product))} />
        {selected && <Text className={styles.hint}>当前库存 {selected.stock}{unit} → 入库后 {roundDecimal(selected.stock + Math.max(0, Number(line.delivered_qty) || 0), 6)}{unit}</Text>}
        <Text>规格 / 楞别</Text><Input disabled={saving} className={styles.input} placeholder='如 1550×705/A（选填）' value={line.specification} onInput={e => updateLine(line.key, { specification: e.detail.value })} />
        <View className={styles.grid}>
          <View><Text>计划数量（{unit}）</Text><Input disabled={saving} className={styles.input} type='digit' placeholder='计划数量' value={line.quantity} onInput={e => updateLine(line.key, { quantity: sanitizeDecimalInput(e.detail.value, 6) })} /></View>
          <View><Text>单价（元/{unit}）</Text><Input disabled={saving} className={styles.input} type='digit' placeholder='入库单价' value={line.unit_price} onInput={e => updateLine(line.key, { unit_price: sanitizeDecimalInput(e.detail.value, 2) })} /></View>
          <View className={styles.deliveryQty}><Text>实际入库数量（{unit}）</Text><Input disabled={saving} className={styles.input} type='digit' placeholder='实际入库数量' value={line.delivered_qty} onInput={e => updateLine(line.key, { delivered_qty: sanitizeDecimalInput(e.detail.value, 6) })} /></View>
        </View>
        <Text className={styles.hint}>{length && width ? `面积按 ${length}×${width} mm × 实际入库数量计算` : '未设置有效长宽，面积不统计；库存和金额正常计算'}</Text>
        <View className={styles.calc}><View><Text>实际面积</Text><Text>{calculated[index].square.toFixed(4)} ㎡</Text></View><View><Text>实际货款</Text><Text>{formatMoneyPreview(calculated[index].amount)}</Text>{line.delivered_qty.trim() && line.unit_price.trim() && !Number.isFinite(calculated[index].amount) && <Text className={styles.error}>金额超出支持范围，请减少数量或单价</Text>}</View></View>
      </View>;
    })}
    <View className={styles.addLine} onClick={() => { if (!busy.current) setLines(current => [...current, newLine()]); }}>＋ 添加商品</View>
    <View className={styles.total}><Text>实际面积：{totalSquare.toFixed(4)} ㎡</Text><Text>货款合计：{formatMoneyPreview(totalAmount)}</Text></View>
    <Text className={styles.section}>最近入库单</Text>
    {!notes.length ? <View className={styles.empty}>暂无入库单</View> : notes.map(note => <InboundNoteRow key={note.id} note={note} onOpen={openPreview} />)}
    {preview && <View className={styles.preview}>
      <View className={styles.previewTop}><Text className={styles.previewTitle}>入库单 #{preview.id}{preview.voided_at ? ' · 已作废' : ''}</Text><Text className={styles.closePreview} onClick={() => setPreview(null)}>收起</Text></View>
      <Text>日期：{preview.date}　工单：{preview.work_order_no || '未填写'}</Text><Text>供应商：{preview.supplier_name || '未关联'}　操作人：{preview.operator || '未填写'}</Text>
      <View className={styles.tableHead}><Text>商品 / 规格</Text><Text>计划</Text><Text>实际</Text><Text>㎡</Text><Text>货款</Text></View>
      {preview.lines.map((line, index) => <View className={styles.tableRow} key={index}><Text>{line.product_name}<Text>{line.specification}</Text></Text><Text>{line.quantity}{line.unit}</Text><Text>{line.delivered_qty}{line.unit}</Text><Text>{Number(line.square_meters || 0).toFixed(2)}</Text><Text>{formatMoney(line.amount || 0)}</Text></View>)}
      <Text className={styles.previewTotal}>货款：{formatMoney(preview.total_amount)}　实际面积：{preview.total_square_meters.toFixed(4)} ㎡</Text><Text>运费：{formatMoney(Number(preview.freight || 0))}（单独记录）</Text>
      <View className={styles.export} onClick={() => exportCsv(preview)}>导出 CSV</View>{!preview.voided_at && <View className={styles.voidButton} onClick={() => voidNote(preview)}>作废整张入库单</View>}
    </View>}
    <View className={`${styles.fixedSave} ${saving || !ready ? styles.disabled : ''}`} onClick={save}>{saving ? '处理中…' : `确认入库 · ${formatMoneyPreview(totalAmount)}`}</View>
  </ScrollView>;
}
