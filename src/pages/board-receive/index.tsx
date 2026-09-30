import { useRef, useState } from 'react';
import { View, Text, Picker } from '@tarojs/components';
import Taro, { useLoad } from '@tarojs/taro';
import { BoardPage, BoardButton, BoardField, BoardError } from '../../components/BoardUI';
import { BoardBatch, getBoards, receiveBoard, boardSpec, today } from '../../services/boards';
const initial = { supplier: '', date: today(), boardLength: '', boardWidth: '', cartonLength: '', cartonWidth: '', cartonHeight: '', fluteType: 'B', layers: '3', faceGsm: '', linerGsm: '', flutingGsm: '', orderedQty: '', receivedQty: '', billedArea: '', unitPrice: '', warningQty: '0', location: '', deliveryNo: '', remark: '' };
export default function BoardReceive() {
  const [form, setForm] = useState(initial); const [templates, setTemplates] = useState<BoardBatch[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const saving = useRef(false);
  const change = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }));
  const fill = (b: BoardBatch) => { setForm(f => { const next = { ...f }; for (const k of ['supplier', 'boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight', 'fluteType', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm', 'unitPrice', 'warningQty', 'location']) next[k] = String(b[k]); return next; }); };
  useLoad(async params => { try { const rows = await getBoards(); const seen = new Set<string>(); setTemplates(rows.filter(b => { const key = b.specKey + b.supplier; if (seen.has(key)) return false; seen.add(key); return true; })); if (params.from) { const b = rows.find(x => x.id === params.from); if (b) fill(b); } } catch (e) { setError(e.message); } });
  const field = (key: keyof typeof initial, label: string, numeric = false, unit?: string, optional = false) => <BoardField key={key} label={label} value={form[key]} onChange={v => change(key, v)} numeric={numeric} unit={unit} optional={optional} />;
  const gift = Math.max(0, Number(form.receivedQty) - Number(form.orderedQty)); const shortage = Math.max(0, Number(form.orderedQty) - Number(form.receivedQty));
  const amount = Number(form.billedArea) * Number(form.unitPrice);
  const save = async () => {
    if (saving.current) return;
    const required: [keyof typeof initial, string][] = [['supplier', '板厂'], ['boardLength', '纸板长'], ['boardWidth', '纸板宽'], ['cartonLength', '纸箱长'], ['cartonWidth', '纸箱宽'], ['cartonHeight', '纸箱高'], ['orderedQty', '订购数'], ['receivedQty', '实收数'], ['billedArea', '计费平米'], ['unitPrice', '每平米单价']];
    for (const [key, label] of required) if (!form[key].trim()) { setError('请填写' + label); return; }
    saving.current = true; setBusy(true); setError('');
    try { const b = await receiveBoard({ ...form, faceGsm: form.faceGsm || '0', linerGsm: form.linerGsm || '0', flutingGsm: form.flutingGsm || '0' }); Taro.redirectTo({ url: '/pages/board-detail/index?id=' + b.id + '&received=1' }); } catch (e) { setError(e.message); } finally { saving.current = false; setBusy(false); }
  };
  return <BoardPage title='来料入库' subtitle='照着送货单填，实收多少就入库多少。'>
    {templates.length > 0 && <View className='board-section'><Text className='board-section-title'>常用规格，少填一次</Text><Picker mode='selector' range={['选择之前的来料…', ...templates.map(b => boardSpec(b) + ' · ' + b.fluteType + '楞 · ' + b.supplier)]} onChange={e => { const b = templates[Number(e.detail.value) - 1]; if (b) fill(b); }}><View className='board-input-wrap'>从历史来料带入规格和板厂 ›</View></Picker></View>}
    <View className='board-section'><Text className='board-section-title'>01 · 板厂与送货信息</Text>{field('supplier', '板厂名称')}<Text className='board-field-label'>送货日期</Text><Picker mode='date' value={form.date} end={today()} onChange={e => change('date', e.detail.value)}><View className='board-input-wrap'>{form.date}</View></Picker><View style={{ marginTop: 16 }}>{field('deliveryNo', '送货单号', false, undefined, true)}{field('location', '库位', false, undefined, true)}</View></View>
    <View className='board-section'><Text className='board-section-title'>02 · 纸板与成箱规格</Text><Text className='board-muted'>原材料尺寸 · 厘米</Text><View className='board-grid'>{field('boardLength', '纸板长', true, 'cm')}{field('boardWidth', '纸板宽', true, 'cm')}{field('fluteType', '楞型')}{field('layers', '层数', true, '层')}</View><Text className='board-muted'>对应成品纸箱 · 厘米</Text><View className='board-grid three'>{field('cartonLength', '纸箱长', true)}{field('cartonWidth', '纸箱宽', true)}{field('cartonHeight', '纸箱高', true)}</View><Text className='board-note'>两套规格一起保存，扫码和领料都能看见。</Text><View className='board-grid three'>{field('faceGsm', '面纸克重', true)}{field('linerGsm', '里纸克重', true)}{field('flutingGsm', '楞纸克重', true)}</View><Text className='board-muted'>克重单位 g/m²，不清楚可留空。</Text></View>
    <View className='board-section'><Text className='board-section-title'>03 · 数量与货款</Text><View className='board-grid'>{field('orderedQty', '订购数', true, '张')}{field('receivedQty', '实收数', true, '张')}</View>{form.orderedQty && form.receivedQty && <Text className='board-note'>{gift ? '多送 ' + gift + ' 张，全部计入库存；货款按下方计费平米计算。' : shortage ? '少送 ' + shortage + ' 张，按实际收到的数量入库。' : '实收与订购数量一致。'}</Text>}<View className='board-grid'>{field('billedArea', '计费平米', true, 'm²')}{field('unitPrice', '每平米单价', true, '元')}</View><Text className='board-muted'>计费平米照送货单填写，不用实收数量代替计费数量。</Text><View className='board-detail-row'><Text>本批货款</Text><strong>¥ {Number.isFinite(amount) ? amount.toFixed(2) : '—'}</strong></View>{field('warningQty', '规格预警线', true, '张')}<Text className='board-muted'>同规格各批次库存合计不高于此值时提醒；0 表示不启用。</Text></View>
    <View className='board-section'>{field('remark', '备注', false, undefined, true)}</View>
    {error && <BoardError message={error} />}
    <BoardButton disabled={busy} onClick={save}>{busy ? '正在保存…' : '确认入库 · 生成批次标签'}</BoardButton>
  </BoardPage>;
}
