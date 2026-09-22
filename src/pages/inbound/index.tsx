import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addDeliveryNote, deliveryNoteCsvUrl, getDeliveryNotes, getSuppliers, type DeliveryLine, type DeliveryNote } from '@/services/api';
import { getBaseUrl } from '@/services/request';
import { session } from '@/services/session';
import type { Customer } from '@/types';
import styles from './index.module.scss';

type EditableLine = DeliveryLine & { key: string };
const newLine = (): EditableLine => ({ key: `${Date.now()}-${Math.random()}`, product_name: '', specification: '', quantity: 1, unit_price: 0, delivered_qty: 1 });
const dimensions = (spec: string) => { const m = spec.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };

export default function InboundPage() {
  const [suppliers, setSuppliers] = useState<Customer[]>([]);
  const [notes, setNotes] = useState<DeliveryNote[]>([]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [workOrder, setWorkOrder] = useState('');
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [freight, setFreight] = useState('0');
  const [remark, setRemark] = useState('');
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<DeliveryNote | null>(null);

  const load = useCallback(async () => {
    try { const [s, n] = await Promise.all([getSuppliers(), getDeliveryNotes()]); setSuppliers(s); setNotes(n.slice(0, 5)); } catch (error) { console.error('[Inbound] load', error); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const supplier = suppliers.find(item => item.id === supplierId);
  const calculated = useMemo(() => lines.map(line => { const [length, width] = dimensions(line.specification); const quantity = Number(line.quantity) || 0; const price = Number(line.unit_price) || 0; return { square: quantity * length * width / 1000000, amount: quantity * price }; }), [lines]);
  const totalSquare = calculated.reduce((sum, item) => sum + item.square, 0);
  const totalAmount = calculated.reduce((sum, item) => sum + item.amount, 0);
  const updateLine = (key: string, patch: Partial<EditableLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...patch } : line));
  const save = async () => {
    if (!lines.length || lines.some(line => !line.specification.trim())) { Taro.showToast({ title: '每行都要填写规格/楞别', icon: 'none' }); return; }
    if (lines.some(line => Number(line.quantity) <= 0 || Number(line.delivered_qty) <= 0)) { Taro.showToast({ title: '数量和送货数必须大于 0', icon: 'none' }); return; }
    if (saving) return; setSaving(true);
    try {
      const note = await addDeliveryNote({ date, work_order_no: workOrder, supplier_id: supplierId, supplier_name: supplier?.name || '', driver_phone: driverPhone, vehicle_no: vehicleNo, freight: Number(freight) || 0, remark, lines: lines.map(({ key, ...line }) => line), operator: '' });
      Taro.showToast({ title: '入库单保存成功', icon: 'success' });
      setPreview(note); setWorkOrder(''); setDriverPhone(''); setVehicleNo(''); setFreight('0'); setRemark(''); setSupplierId(null); setLines([newLine()]); await load();
    } catch (error) { Taro.showToast({ title: (error as any)?.message || '保存失败', icon: 'none' }); }
    finally { setSaving(false); }
  };
  const exportCsv = async (note: DeliveryNote) => { try { const result = await Taro.downloadFile({ url: `${getBaseUrl()}${deliveryNoteCsvUrl(note.id)}`, header: session()?.token ? { Authorization: `Bearer ${session()!.token}` } : {} }); if (result.statusCode !== 200) throw new Error('导出失败'); Taro.showToast({ title: '送货单 CSV 已生成', icon: 'success' }); } catch (error) { Taro.showToast({ title: (error as any)?.message || '导出失败', icon: 'none' }); } };
  return <ScrollView scrollY className={styles.page} refresherEnabled onRefresherRefresh={load}>
    <Text className={styles.title}>纸板入库单</Text><Text className={styles.subTitle}>一张送货单可录入多行纸板，保存后自动入库</Text>
    <View className={styles.card}><View className={styles.row}><View className={styles.half}><Text>日期</Text><Picker mode="date" value={date} onChange={e => setDate(e.detail.value)}><View className={styles.picker}>{date}</View></Picker></View><View className={styles.half}><Text>工单编号 / 采购单号</Text><Input className={styles.input} value={workOrder} onInput={e => setWorkOrder(e.detail.value)} /></View></View><Text>收货单位 / 供应商</Text><Picker range={['不关联供应商', ...suppliers.map(item => item.name)]} onChange={e => { const index = Number(e.detail.value); setSupplierId(index ? suppliers[index - 1]?.id || null : null); }}><View className={styles.picker}>{supplier?.name || '选择供应商（选填）'}</View></Picker><View className={styles.row}><View className={styles.half}><Text>司机电话</Text><Input className={styles.input} value={driverPhone} onInput={e => setDriverPhone(e.detail.value)} /></View><View className={styles.half}><Text>车号</Text><Input className={styles.input} value={vehicleNo} onInput={e => setVehicleNo(e.detail.value)} /></View></View><View className={styles.row}><View className={styles.half}><Text>运费</Text><Input className={styles.input} type="digit" value={freight} onInput={e => setFreight(e.detail.value)} /></View><View className={styles.half}><Text>备注</Text><Input className={styles.input} value={remark} onInput={e => setRemark(e.detail.value)} /></View></View></View>
    <Text className={styles.section}>纸板明细</Text>
    {lines.map((line, index) => <View className={styles.lineCard} key={line.key}><View className={styles.lineHead}><Text>第 {index + 1} 行</Text>{lines.length > 1 && <Text className={styles.remove} onClick={() => setLines(current => current.filter(item => item.key !== line.key))}>删除</Text>}</View><Text>规格 / 楞别（长×宽/楞型）</Text><Input className={styles.input} placeholder="如 1550×705/A" value={line.specification} onInput={e => updateLine(line.key, { specification: e.detail.value })} /><View className={styles.grid}><View><Text>数量（张）</Text><Input className={styles.input} type="number" value={String(line.quantity)} onInput={e => updateLine(line.key, { quantity: Number(e.detail.value) || 0 })} /></View><View><Text>单价（元/张）</Text><Input className={styles.input} type="digit" value={String(line.unit_price)} onInput={e => updateLine(line.key, { unit_price: Number(e.detail.value) || 0 })} /></View><View className={styles.deliveryQty}><Text>送货数（张）</Text><Input className={styles.input} type="number" value={String(line.delivered_qty)} onInput={e => updateLine(line.key, { delivered_qty: Number(e.detail.value) || 0 })} /></View></View><View className={styles.calc}><View><Text>平米数</Text><Text>{calculated[index].square.toFixed(4)} ㎡</Text></View><View><Text>金额</Text><Text>¥{calculated[index].amount.toFixed(2)}</Text></View></View></View>)}
    <View className={styles.addLine} onClick={() => setLines(current => [...current, newLine()])}>＋ 添加一行纸板</View><View className={styles.total}><Text>合计总平米：{totalSquare.toFixed(4)} ㎡</Text><Text>合计总金额：¥{totalAmount.toFixed(2)}</Text></View>
    <Text className={styles.section}>最近送货单</Text>{notes.length === 0 ? <View className={styles.empty}>暂无送货单</View> : notes.map(note => <View className={styles.note} key={note.id} onClick={() => setPreview(note)}><Text>{note.date} · {note.work_order_no || '未填单号'}</Text><Text>{note.supplier_name || '未关联供应商'} · {note.lines.length} 行 · ¥{note.total_amount.toFixed(2)}</Text></View>)}
    {preview && <View className={styles.preview}><View className={styles.previewTop}><Text className={styles.previewTitle}>纸板送货单</Text><Text className={styles.closePreview} onClick={() => setPreview(null)}>收起</Text></View><Text>日期：{preview.date}　工单：{preview.work_order_no || '未填写'}</Text><Text>供应商：{preview.supplier_name || '未填写'}　车号：{preview.vehicle_no || '未填写'}</Text><View className={styles.tableHead}><Text>规格/楞别</Text><Text>数量</Text><Text>送货数</Text><Text>平米</Text><Text>金额</Text></View>{preview.lines.map((line, i) => <View className={styles.tableRow} key={i}><Text>{line.specification}</Text><Text>{line.quantity}</Text><Text>{line.delivered_qty}</Text><Text>{Number(line.square_meters).toFixed(2)}</Text><Text>{Number(line.amount).toFixed(2)}</Text></View>)}<Text className={styles.previewTotal}>合计：{preview.total_square_meters.toFixed(4)} ㎡　¥{preview.total_amount.toFixed(2)}</Text><View className={styles.export} onClick={() => exportCsv(preview)}>导出 CSV</View><Text className={styles.capture}>可直接在此预览页截图留存</Text></View>}
    <View className={styles.fixedSave} onClick={save}>{saving ? '保存中…' : '确认入库'}</View>
  </ScrollView>;
}
