import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Picker, Input, Button } from '@tarojs/components';
import Taro, { useLoad } from '@tarojs/taro';
import { BoardButton, BoardError } from '../../components/BoardUI';
import StockEntryLayout from '@/components/StockEntryLayout';
import { BoardBatch, getBoards, getBoard, receiveBoard, updateBoard, boardSpec, today } from '../../services/boards';
import { BusinessSpecification, getBusinessSpecifications } from '../../services/business-workflow';
import { useSharedRefresh } from '../../services/shared-refresh';
import { watchSession } from '../../services/session';
import './simple-entry.scss';
const initial = { supplier: '', date: today(), boardLength: '', boardWidth: '', cartonLength: '', cartonWidth: '', cartonHeight: '', fluteType: 'B', layers: '3', faceGsm: '', linerGsm: '', flutingGsm: '', orderedQty: '', receivedQty: '', billedArea: '', unitPrice: '', warningQty: '0', location: '', deliveryNo: '', remark: '' };
export default function BoardReceive() {
  const [form, setForm] = useState(() => ({ ...initial, date: today() })); const [selected, setSelected] = useState<BoardBatch | null>(null); const [templates, setTemplates] = useState<BoardBatch[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const saving = useRef(false);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [customField, setCustomField] = useState('');
  const orderedQuantityEdited = useRef(false);
  const [templateQuery, setTemplateQuery] = useState('');
  const [allRows, setAllRows] = useState<BoardBatch[]>([]);
  const [editingId, setEditingId] = useState('');
  const [editReady, setEditReady] = useState(false);
  const [boardLoadError, setBoardLoadError] = useState('');
  const [sharedSpecs, setSharedSpecs] = useState<BusinessSpecification[]>([]);
  const [specError, setSpecError] = useState('');
  const mounted = useRef(true);
  const boardSequence = useRef(0), specSequence = useRef(0);
  const routeParams = useRef<{ id: string; from: string } | null>(null);
  const initialBatchApplied = useRef(false), draftChanged = useRef(false);
  const fieldsDisabled = busy || Boolean(editingId && !editReady);
  const loadSpecs = useCallback(async () => {
    const current = ++specSequence.current;
    try { const rows = await getBusinessSpecifications(); if (!mounted.current || current !== specSequence.current) return; setSharedSpecs(rows); setSpecError(''); }
    catch (e) { if (mounted.current && current === specSequence.current) setSpecError(e.message || '共享规格读取失败'); }
  }, []);
  useEffect(() => { void loadSpecs(); }, [loadSpecs]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; boardSequence.current += 1; specSequence.current += 1; }; }, []);
  const applySharedSpec = (spec: BusinessSpecification) => {
    if (saving.current) return;
    draftChanged.current = true;
    setSelected(null); setSpecsOpen(false);
    setForm(f => ({ ...f, ...(spec.board ? { boardLength: String(spec.board[0]), boardWidth: String(spec.board[1]) } : { boardLength: '', boardWidth: '' }), ...(spec.carton ? { cartonLength: String(spec.carton[0]), cartonWidth: String(spec.carton[1]), cartonHeight: String(spec.carton[2]) } : { cartonLength: '', cartonWidth: '', cartonHeight: '' }), ...(spec.fluteType ? { fluteType: spec.fluteType } : {}), ...(spec.layers ? { layers: String(spec.layers) } : {}) }));
  };
  const change = (key: string, value: string) => {
    if (saving.current) return;
    draftChanged.current = true;
    if (key === 'orderedQty') orderedQuantityEdited.current = true;
    setForm(f => ({ ...f, [key]: value, ...(key === 'receivedQty' && !orderedQuantityEdited.current ? { orderedQty: value } : {}) }));
  };
  const fill = useCallback((b: BoardBatch) => { if (saving.current) return; draftChanged.current = true; orderedQuantityEdited.current = false; setSelected(b); setSpecsOpen(false); setError(''); setForm(() => { const next = { ...initial, date: today() }; for (const k of ['supplier', 'boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight', 'fluteType', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm', 'unitPrice', 'warningQty', 'location']) next[k] = String(b[k] ?? ''); return next; }); }, []);
  const loadBoards = useCallback(async () => {
    const params = routeParams.current;
    if (!params) return;
    const current = ++boardSequence.current;
    try {
      const [rows, editing] = await Promise.all([getBoards(), params.id && !initialBatchApplied.current ? getBoard(params.id) : Promise.resolve(null)]);
      if (!mounted.current || current !== boardSequence.current) return;
      setAllRows(rows);
      const seen = new Set<string>();
      setTemplates(rows.slice().sort((a, b) => b.createdAt - a.createdAt).filter(b => { const key = JSON.stringify([b.specKey, b.supplier]); if (seen.has(key)) return false; seen.add(key); return true; }));
      setBoardLoadError('');
      // Refresh history after authentication without reapplying a route template
      // or replacing a draft which the user has already started editing.
      if (!initialBatchApplied.current && !saving.current) {
        initialBatchApplied.current = true;
        if (!draftChanged.current) {
          if (editing) { orderedQuantityEdited.current = true; setForm(Object.fromEntries(Object.keys(initial).map(k => [k, String(editing[k] ?? '')])) as typeof initial); }
          else if (params.from) { const batch = rows.find(b => b.id === params.from); if (batch) fill(batch); }
        }
        if (params.id) setEditReady(true);
      }
    } catch (e) { if (mounted.current && current === boardSequence.current) setBoardLoadError(e.message || '入库资料读取失败'); }
  }, [fill]);
  useSharedRefresh(() => { void loadSpecs(); void loadBoards(); });
  useEffect(() => watchSession(() => { void loadSpecs(); void loadBoards(); }), [loadSpecs, loadBoards]);
  useLoad(params => { routeParams.current = { id: params.id || '', from: params.from || '' }; setEditingId(params.id || ''); setEditReady(!params.id); void loadBoards(); });
  const field = (key: keyof typeof initial, label: string, numeric = false, unit?: string) => <View className='stock-entry-field' key={key}><Text className='stock-entry-label'>{label}</Text><View className='board-input-wrap'><Input disabled={fieldsDisabled} aria-label={label} type={numeric ? 'digit' : 'text'} value={form[key]} onInput={e => change(key, e.detail.value)} maxlength={key === 'remark' ? 500 : 120} />{unit && <Text className='board-muted'>{unit}</Text>}</View></View>;
  const dimension = (key: keyof typeof initial, label: string) => <Input key={key} aria-label={label} disabled={fieldsDisabled} type='digit' placeholder={label.replace(/^纸板|^纸箱/, '')} value={form[key]} onInput={e => change(key, e.detail.value)} />;
  const options = (key: string) => [...new Set(allRows.map(b => String(b[key] || '')).filter(Boolean))];
  const selectField = (key: keyof typeof initial, label: string, choices: string[], custom = false) => <View className='stock-entry-field'><Text className='stock-entry-label'>{label}</Text><Picker disabled={fieldsDisabled} mode='selector' range={['请选择' + label, ...choices, ...(custom ? ['新增 / 手动填写'] : [])]} onChange={e => { const value = choices[Number(e.detail.value) - 1]; if (value) { change(key, value); setCustomField(''); } else if (custom && Number(e.detail.value) === choices.length + 1) { setCustomField(key); change(key, ''); } }}><View className='board-input-wrap'>{form[key] || '请选择' + label} ▾</View></Picker>{customField === key && <View className='board-input-wrap board-entry-custom'><Input disabled={fieldsDisabled} aria-label={key === 'location' ? '库位名称' : '自定义楞型'} value={form[key]} onInput={e => change(key, e.detail.value)} /></View>}</View>;
  const matches = templates.filter(b => [boardSpec(b), b.supplier, b.fluteType, b.layers + '层'].join(' ').toLowerCase().replace(/[ ×x*]/g, '').includes(templateQuery.toLowerCase().replace(/[ ×x*]/g, '')));
  const gift = Math.max(0, Number(form.receivedQty) - Number(form.orderedQty)); const shortage = Math.max(0, Number(form.orderedQty) - Number(form.receivedQty));
  const amount = Number(form.billedArea) * Number(form.unitPrice);
  const save = async () => {
    if (saving.current) return;
    if (routeParams.current?.id && !editReady) { setError('请先读取原入库单后再保存'); return; }
    const required: [keyof typeof initial, string][] = [['supplier', '板厂'], ['boardLength', '纸板长'], ['boardWidth', '纸板宽'], ['cartonLength', '纸箱长'], ['cartonWidth', '纸箱宽'], ['cartonHeight', '纸箱高'], ['orderedQty', '订购数'], ['receivedQty', '实收数'], ['billedArea', '计费平米'], ['unitPrice', '每平米单价']];
    for (const [key, label] of required) if (!form[key].trim()) { setError('请填写' + label); return; }
    saving.current = true; setBusy(true); setError('');
    try { const b = await (editingId ? (data => updateBoard(editingId, data)) : receiveBoard)({ ...form, faceGsm: form.faceGsm || '0', linerGsm: form.linerGsm || '0', flutingGsm: form.flutingGsm || '0' }); Taro.redirectTo({ url: '/pages/board-detail/index?id=' + b.id + (editingId ? '' : '&received=1') }); } catch (e) { setError(e.message); } finally { saving.current = false; setBusy(false); }
  };
  return <StockEntryLayout title={editingId ? '编辑纸板入库' : '纸板入库'} busy={busy} onRefresh={() => { void loadSpecs(); void loadBoards(); }}>
    <View className='board-simple-entry'>
      {boardLoadError && <BoardError message={boardLoadError} retry={loadBoards} />}
      {editingId && !editReady && !boardLoadError && <Text className='stock-entry-note'>正在读取原入库单…</Text>}
      {!editingId && <View className='board-entry-reuse'><Button className='stock-entry-secondary' disabled={fieldsDisabled} aria-expanded={specsOpen} onClick={() => setSpecsOpen(!specsOpen)}>选择已有规格 <Text>{specsOpen ? '收起 −' : '展开 ＋'}</Text></Button>
        {specsOpen && <View className='stock-entry-section'>
          <Text className='stock-entry-label'>客户 / 商品共享规格</Text><Picker disabled={fieldsDisabled} range={['选择客户 / 商品规格', ...sharedSpecs.filter(s => s.source !== 'board').map(s => s.name + ' · ' + (s.carton || s.board || []).join(' × ') + ' cm')]} onChange={e => { const spec = sharedSpecs.filter(s => s.source !== 'board')[Number(e.detail.value) - 1]; if (spec) applySharedSpec(spec); }}><View className='board-input-wrap'>选择已保存的规格 ›</View></Picker>
          {specError && <BoardError message={specError} retry={loadSpecs} />}
          {templates.length > 0 && <View className='board-entry-history'><Text className='stock-entry-label'>历史入库规格</Text><Input disabled={fieldsDisabled} aria-label='搜索历史规格' className='stock-entry-input' value={templateQuery} onInput={e => setTemplateQuery(e.detail.value)} placeholder='尺寸、供货商、楞型' /><View className='board-template-list'>{matches.slice(0, 3).map(b => <BoardButton key={b.id} secondary disabled={fieldsDisabled} onClick={() => fill(b)}>{boardSpec(b)} cm · {b.fluteType}楞 · {b.supplier}</BoardButton>)}</View><Picker disabled={fieldsDisabled} range={['选择之前的来料…', ...matches.map(b => boardSpec(b) + ' · ' + b.fluteType + '楞 · ' + b.supplier)]} onChange={e => { const b = matches[Number(e.detail.value) - 1]; if (b) fill(b); }}><View className='board-input-wrap'>选择其他历史规格 ›</View></Picker></View>}
          <Text className='stock-entry-note'>两套规格分别带入，未保存的尺寸需自行填写。</Text>
        </View>}
      </View>}
      {selected && <Text className='stock-entry-note'>已带入历史规格，本次另建新批次；确认保存后才增加库存。</Text>}
      <View className='stock-entry-section'>
        <View className='stock-entry-field'><View className='stock-entry-row'><Text className='stock-entry-label'>供货商</Text>{options('supplier').length > 0 && <Picker disabled={fieldsDisabled} range={['选择已有供货商', ...options('supplier')]} onChange={e => { const supplier = options('supplier')[Number(e.detail.value) - 1]; if (supplier) change('supplier', supplier); }}><Text className='board-entry-picker-link'>选择已有 ›</Text></Picker>}</View><Input disabled={fieldsDisabled} aria-label='板厂名称' className='stock-entry-input' value={form.supplier} onInput={e => change('supplier', e.detail.value)} /></View>
        <View className='stock-entry-field'><Text className='stock-entry-label'>纸板规格尺寸（cm）</Text><View className='board-entry-dimensions'>{dimension('boardLength', '纸板长')}<Text>×</Text>{dimension('boardWidth', '纸板宽')}</View></View>
        <View className='stock-entry-field'><Text className='stock-entry-label'>成箱规格尺寸（cm）</Text><View className='board-entry-dimensions'>{dimension('cartonLength', '纸箱长')}<Text>×</Text>{dimension('cartonWidth', '纸箱宽')}<Text>×</Text>{dimension('cartonHeight', '纸箱高')}</View></View>
        {field('receivedQty', '实收数', true, '张')}
        <View className='stock-entry-grid'>{field('billedArea', '计费平米', true, 'm²')}{field('unitPrice', '每平米单价', true, '元')}</View>
        <Text className='stock-entry-note'>计费平米按送货单填写，货款不按实收张数计算。</Text>
        <View className='stock-entry-field'><Text className='stock-entry-label'>业务日期</Text><Picker disabled={fieldsDisabled} mode='date' value={form.date} end={today()} onChange={e => change('date', e.detail.value)}><View className='board-input-wrap' aria-label='业务日期'>{form.date}</View></Picker></View>
        <View className='board-detail-row'><Text>本批货款</Text><strong>¥ {Number.isFinite(amount) ? amount.toFixed(2) : '—'}</strong></View>
      </View>
      <Button className='stock-entry-more' disabled={fieldsDisabled} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>更多信息 <Text>{moreOpen ? '收起 −' : '展开 ＋'}</Text></Button>
      {moreOpen && <View className='stock-entry-section'>
        {field('orderedQty', '订购数', true, '张')}
        <Text className='stock-entry-note'>{editingId ? '保留原订购数，可按原单调整。' : '未单独修改时，订购数随实收数填写；超收、少收时请按原单修改。'}</Text>
        {form.orderedQty && form.receivedQty && <Text className='stock-entry-note'>{gift ? '多送 ' + gift + ' 张，全部计入库存；货款按计费平米计算。' : shortage ? '少送 ' + shortage + ' 张，按实际收到的数量入库。' : '实收与订购数量一致。'}</Text>}
        <View className='stock-entry-grid'>{selectField('fluteType', '楞型', ['A', 'B', 'C', 'E', 'AB', 'BC'], true)}{selectField('layers', '层数', ['2', '3', '5', '7'])}</View>
        <View className='stock-entry-grid'>{field('faceGsm', '面纸克重', true)}{field('linerGsm', '里纸克重', true)}{field('flutingGsm', '楞纸克重', true)}</View>
        <Text className='stock-entry-note'>克重单位 g/m²，不清楚可留空。</Text>
        {field('deliveryNo', '送货单号')}{selectField('location', '库位', options('location'), true)}{field('warningQty', '规格预警线', true, '张')}
        <Text className='stock-entry-note'>预警线按同规格库存合计判断；0 表示不启用。</Text>
        {field('remark', '备注')}
      </View>}
      {error && <BoardError message={error} />}
      <Button className='stock-entry-primary' disabled={fieldsDisabled} onClick={save}>{busy ? '正在保存…' : editingId ? '保存修改' : '确认入库 · 生成批次标签'}</Button>
    </View>
  </StockEntryLayout>;
}
