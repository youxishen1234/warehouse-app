import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Picker, Input, Button } from '@tarojs/components';
import Taro, { useLoad } from '@tarojs/taro';
import { BoardButton, BoardError } from '../../components/BoardUI';
import StockEntryLayout from '@/components/StockEntryLayout';
import { PartySearchPanel, GoodsCards, type PartyGood } from '@/components/PartySearchPanel';
import { getSuppliers } from '@/services/api';
import type { Supplier } from '@/types';
import { BoardBatch, getBoards, getBoard, receiveBoard, receiveBoards, updateBoard, boardSpec, today } from '../../services/boards';
import { BusinessSpecification, getBusinessSpecifications } from '../../services/business-workflow';
import { useSharedRefresh } from '../../services/shared-refresh';
import { watchSession } from '../../services/session';
import { formatSpecificationInput } from '../print-center/specification-input';
import { parseDimensionSpecification, preserveDimensionGrouping, shouldPreserveDimensionGrouping, specificationFromDimensions } from './specification-input';
import './simple-entry.scss';
const initial = { supplier: '', customerName: '', material: '', printPlate: '', printColor: '', date: today(), boardLength: '', boardWidth: '', cartonLength: '', cartonWidth: '', cartonHeight: '', fluteType: 'B', layers: '3', faceGsm: '', linerGsm: '', flutingGsm: '', orderedQty: '', receivedQty: '', billedArea: '', unitPrice: '', freight: '', warningQty: '0', location: '', deliveryNo: '', remark: '' };
type BoardDraft = Record<string, string | number | null>;
export default function BoardReceive() {
  const [form, setForm] = useState(() => ({ ...initial, date: today() })); const [selected, setSelected] = useState<BoardBatch | null>(null); const [templates, setTemplates] = useState<BoardBatch[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const saving = useRef(false);
  const [boardSpecification, setBoardSpecification] = useState('');
  const [cartonSpecification, setCartonSpecification] = useState('');
  const [specsOpen, setSpecsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [customField, setCustomField] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [supplierError, setSupplierError] = useState('');
  const [pending, setPending] = useState<Array<{key: string; data: BoardDraft}>>([]);
  const supplier = suppliers.find(item => item.id === supplierId && !item.deleted_at);
  const supplierSpecs = (supplier?.specs || []).filter(item => item.category === '纸板' || item.kind === '纸板');
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
  const loadSuppliers = useCallback(async () => {
    try { const rows = await getSuppliers(); if (mounted.current) { setSuppliers(rows); setSupplierError(''); } }
    catch (e) { if (mounted.current) setSupplierError(e.message || '供货商资料读取失败'); }
  }, []);
  useEffect(() => { void loadSuppliers(); }, [loadSuppliers]);
  const applySupplierSpec = (spec: PartyGood) => {
    if (saving.current) return;
    draftChanged.current = true;
    setSelected(null);
    const text = (value: unknown) => value == null ? '' : String(value);
    setBoardSpecification(spec.boardLength && spec.boardWidth ? specificationFromDimensions([spec.boardLength, spec.boardWidth]) : spec.specification || '');
    setCartonSpecification(spec.cartonLength && spec.cartonWidth && spec.cartonHeight ? specificationFromDimensions([spec.cartonLength, spec.cartonWidth, spec.cartonHeight]) : '');
    setForm(f => ({ ...f, boardLength: text(spec.boardLength), boardWidth: text(spec.boardWidth), cartonLength: text(spec.cartonLength), cartonWidth: text(spec.cartonWidth), cartonHeight: text(spec.cartonHeight), material: spec.material || '', fluteType: spec.fluteType || '', layers: text(spec.layers), unitPrice: text(spec.unitPrice ?? spec.price) }));
  };
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
    const boardSize = spec.board ? specificationFromDimensions(spec.board) : '';
    const cartonSize = spec.carton ? specificationFromDimensions(spec.carton) : '';
    setBoardSpecification(boardSize);
    setCartonSpecification(cartonSize);
    setForm(f => ({ ...f, ...(spec.board ? { boardLength: String(spec.board[0]), boardWidth: String(spec.board[1]) } : { boardLength: '', boardWidth: '' }), ...(spec.carton ? { cartonLength: String(spec.carton[0]), cartonWidth: String(spec.carton[1]), cartonHeight: String(spec.carton[2]) } : { cartonLength: '', cartonWidth: '', cartonHeight: '' }), ...(spec.fluteType ? { fluteType: spec.fluteType } : {}), ...(spec.layers ? { layers: String(spec.layers) } : {}) }));
  };
  const changeSpecification = (kind: 'board' | 'carton', value: string) => {
    if (saving.current) return;
    draftChanged.current = true;
    const previous = kind === 'board' ? boardSpecification : cartonSpecification;
    const dimensionCount = kind === 'board' ? 2 : 3;
    const next = shouldPreserveDimensionGrouping(value, previous)
      ? preserveDimensionGrouping(value)
      : formatSpecificationInput(value, previous, dimensionCount);
    const parsed = parseDimensionSpecification(next, dimensionCount);
    if (kind === 'board') {
      setBoardSpecification(next);
      setForm(f => ({ ...f, boardLength: parsed ? String(parsed[0]) : '', boardWidth: parsed ? String(parsed[1]) : '' }));
    } else {
      setCartonSpecification(next);
      setForm(f => ({ ...f, cartonLength: parsed ? String(parsed[0]) : '', cartonWidth: parsed ? String(parsed[1]) : '', cartonHeight: parsed ? String(parsed[2]) : '' }));
    }
  };
  const change = (key: string, value: string) => {
    if (saving.current) return;
    draftChanged.current = true;
    if (key === 'orderedQty') orderedQuantityEdited.current = true;
    setForm(f => ({ ...f, [key]: value, ...(key === 'receivedQty' && !orderedQuantityEdited.current ? { orderedQty: value } : {}) }));
  };
  const fill = useCallback((b: BoardBatch) => { if (saving.current) return; draftChanged.current = true; orderedQuantityEdited.current = false; setSelected(b); setSpecsOpen(false); setError(''); setBoardSpecification(specificationFromDimensions([b.boardLength, b.boardWidth])); setCartonSpecification(specificationFromDimensions([b.cartonLength, b.cartonWidth, b.cartonHeight])); setForm(() => { const next = { ...initial, date: today() }; for (const k of ['customerName', 'material', 'boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight', 'fluteType', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm', 'unitPrice', 'warningQty', 'location']) next[k] = String(b[k] ?? ''); return next; }); }, []);
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
          if (editing) { setSupplierId(editing.supplier_id ?? null); orderedQuantityEdited.current = true; setBoardSpecification(specificationFromDimensions([editing.boardLength, editing.boardWidth])); setCartonSpecification(specificationFromDimensions([editing.cartonLength, editing.cartonWidth, editing.cartonHeight])); setForm(Object.fromEntries(Object.keys(initial).map(k => [k, String(editing[k] ?? '')])) as typeof initial); }
          else if (params.from) { const batch = rows.find(b => b.id === params.from); if (batch) fill(batch); }
        }
        if (params.id) setEditReady(true);
      }
    } catch (e) { if (mounted.current && current === boardSequence.current) setBoardLoadError(e.message || '入库资料读取失败'); }
  }, [fill]);
  useSharedRefresh(() => { void loadSpecs(); void loadBoards(); void loadSuppliers(); });
  useEffect(() => watchSession(() => { void loadSpecs(); void loadBoards(); void loadSuppliers(); }), [loadSpecs, loadBoards, loadSuppliers]);
  useLoad(params => { routeParams.current = { id: params.id || '', from: params.from || '' }; setEditingId(params.id || ''); setEditReady(!params.id); void loadBoards(); });
  const field = (key: keyof typeof initial, label: string, numeric = false, unit?: string) => <View className='stock-entry-field' key={key}><Text className='stock-entry-label'>{label}</Text><View className='board-input-wrap'><Input disabled={fieldsDisabled} aria-label={label} type={numeric ? 'digit' : 'text'} value={form[key]} onInput={e => change(key, e.detail.value)} maxlength={key === 'remark' ? 500 : 120} />{unit && <Text className='board-muted'>{unit}</Text>}</View></View>;
  const specificationField = (kind: 'board' | 'carton', label: string, value: string) => <View className='stock-entry-field' key={kind}><Text className='stock-entry-label'>{label}（cm）</Text><View className='board-entry-specification'><Input aria-label={label} disabled={fieldsDisabled} type='text' value={value} onInput={e => changeSpecification(kind, e.detail.value)} /></View></View>;
  const options = (key: string) => [...new Set(allRows.map(b => String(b[key] || '')).filter(Boolean))];
  const selectField = (key: keyof typeof initial, label: string, choices: string[], custom = false) => <View className='stock-entry-field'><Text className='stock-entry-label'>{label}</Text><Picker disabled={fieldsDisabled} mode='selector' range={['请选择' + label, ...choices, ...(custom ? ['新增 / 手动填写'] : [])]} onChange={e => { const value = choices[Number(e.detail.value) - 1]; if (value) { change(key, value); setCustomField(''); } else if (custom && Number(e.detail.value) === choices.length + 1) { setCustomField(key); change(key, ''); } }}><View className='board-input-wrap'>{form[key] || '请选择' + label} ▾</View></Picker>{customField === key && <View className='board-input-wrap board-entry-custom'><Input disabled={fieldsDisabled} aria-label={key === 'location' ? '库位名称' : '自定义楞型'} value={form[key]} onInput={e => change(key, e.detail.value)} /></View>}</View>;
  const matches = templates.filter(b => [boardSpec(b), b.supplier, b.fluteType, b.layers + '层'].join(' ').toLowerCase().replace(/[ ×x*]/g, '').includes(templateQuery.toLowerCase().replace(/[ ×x*]/g, '')));
  const gift = Math.max(0, Number(form.receivedQty) - Number(form.orderedQty)); const shortage = Math.max(0, Number(form.orderedQty) - Number(form.receivedQty));
  const amount = form.billedArea.trim() && form.unitPrice.trim() ? Number(form.billedArea) * Number(form.unitPrice) : null;
  const currentDraft = (): BoardDraft => {
    const boardDimensions = parseDimensionSpecification(boardSpecification, 2);
    if (!boardDimensions) throw new Error('纸板规格尺寸请填写完整的长×宽，且均为正数');
    const cartonDimensions = parseDimensionSpecification(cartonSpecification, 3);
    if (!cartonDimensions) throw new Error('成箱规格尺寸请填写完整的长×宽×高，且均为正数');
    if (supplierId != null && !supplier) throw new Error('所选供货商已停用，请重新选择');
    const required: [keyof typeof initial, string][] = [['orderedQty', '订购数'], ['receivedQty', '实收数'], ['billedArea', '计费平米'], ['unitPrice', '每平米单价']];
    for (const [key, label] of required) if (!form[key].trim()) throw new Error('请填写' + label);
    return { ...form, supplier_id: supplierId, supplier: supplier?.name || '', boardLength: boardDimensions[0], boardWidth: boardDimensions[1], cartonLength: cartonDimensions[0], cartonWidth: cartonDimensions[1], cartonHeight: cartonDimensions[2], freight: form.freight || '0', faceGsm: form.faceGsm || '0', linerGsm: form.linerGsm || '0', flutingGsm: form.flutingGsm || '0' };
  };
  const addNext = () => {
    if (saving.current) return;
    try {
      const data = currentDraft();
      setPending(rows => [...rows, {key: `${Date.now()}-${Math.random()}`, data}]);
      setForm({...initial, supplier: supplier?.name || '', date: form.date});
      setBoardSpecification(''); setCartonSpecification(''); setSelected(null); orderedQuantityEdited.current = false; draftChanged.current = false; setError('');
    } catch (e) { setError(e.message); }
  };
  const changeSupplier = async (id: number | null) => {
    if (saving.current || id === supplierId) return;
    if (pending.length || draftChanged.current) {
      const confirmation = await Taro.showModal({ title: '改变本单关联对象', content: '更改供货商会改变本单全部纸板的关联对象，并清空已选规格和待入库明细。请确认。' });
      if (!confirmation.confirm) return;
      setPending([]); setForm({...initial, date: form.date}); setBoardSpecification(''); setCartonSpecification('');
    }
    setSupplierId(id); draftChanged.current = false;
  };
  const save = async () => {
    if (saving.current) return;
    if (routeParams.current?.id && !editReady) { setError('请先读取原入库单后再保存'); return; }
    let items: BoardDraft[];
    try { items = [...pending.map(row => row.data), ...(!pending.length || boardSpecification || form.receivedQty ? [currentDraft()] : [])]; if (!items.length) throw new Error('请先填写一项纸板入库资料'); }
    catch (e) { setError(e.message); return; }
    saving.current = true; setBusy(true); setError('');
    try {
      const b = editingId ? await updateBoard(editingId, items[0]) : items.length === 1 ? await receiveBoard(items[0]) : (await receiveBoards(supplierId, items)).batches[0];
      Taro.redirectTo({ url: '/pages/board-detail/index?id=' + b.id + (editingId ? '' : '&received=1') });
    } catch (e) { setError(e.message); } finally { saving.current = false; setBusy(false); }
  };
  return <StockEntryLayout title={editingId ? '编辑纸板入库' : '纸板入库'} busy={busy} onRefresh={() => { void loadSpecs(); void loadBoards(); void loadSuppliers(); }}>
    <View className='board-simple-entry'>
      {boardLoadError && <BoardError message={boardLoadError} retry={loadBoards} />}
      {editingId && !editReady && !boardLoadError && <Text className='stock-entry-note'>正在读取原入库单…</Text>}
      {!editingId && <View className='board-entry-reuse'><Button className='stock-entry-secondary' disabled={fieldsDisabled} aria-expanded={specsOpen} onClick={() => setSpecsOpen(!specsOpen)}>选择已有规格 <Text>{specsOpen ? '收起 −' : '展开 ＋'}</Text></Button>
        {specsOpen && <View className='stock-entry-section'>
          <Text className='stock-entry-label'>客户 / 商品共享规格</Text><Input disabled={fieldsDisabled} aria-label='搜索规格' className='stock-entry-input' value={templateQuery} onInput={e => setTemplateQuery(e.detail.value)} placeholder='搜索名称、尺寸或材质' />
          <View className='board-template-list'>{sharedSpecs.filter(s => s.source !== 'board' && [s.name, s.material, ...(s.carton || s.board || [])].join(' ').toLowerCase().includes(templateQuery.toLowerCase())).map(spec => <BoardButton key={spec.id} secondary disabled={fieldsDisabled} onClick={() => applySharedSpec(spec)}>{spec.name} · {(spec.carton || spec.board || []).join(' × ')} cm · {spec.material || '材质未记录'}</BoardButton>)}</View>
          {specError && <BoardError message={specError} retry={loadSpecs} />}
          {templates.length > 0 && <View className='board-entry-history'><Text className='stock-entry-label'>历史入库规格</Text><View className='board-template-list'>{matches.map(b => <BoardButton key={b.id} secondary disabled={fieldsDisabled} onClick={() => fill(b)}>{boardSpec(b)} cm · {b.fluteType}楞 · {b.supplier}</BoardButton>)}</View></View>}
          <Text className='stock-entry-note'>两套规格分别带入，未保存的尺寸需自行填写。</Text>
        </View>}
      </View>}
      {selected && <Text className='stock-entry-note'>已带入历史规格，本次另建新批次；确认保存后才增加库存。</Text>}
      <View className='stock-entry-section'>
        <View className='stock-entry-field'><Text className='stock-entry-label'>供货商（选填）</Text>
          <PartySearchPanel partyType='supplier' parties={suppliers} selectedId={supplierId} disabled={fieldsDisabled} onSelect={item => { void changeSupplier(item?.id ?? null); }} />
          <Text className='stock-entry-note'>{supplier ? '只带入常用规格和采购资料；数量、送货日期和运费按本次业务填写。' : '不关联供货商，只增加库存，不生成供货商应付。'}</Text>
          {supplierError && <BoardError message={supplierError} retry={loadSuppliers} />}
          {supplier && <GoodsCards items={supplierSpecs} onSelect={applySupplierSpec} disabled={fieldsDisabled} />}
        </View>
        <Text className='stock-entry-label'>批次资料</Text>
        <Text className='stock-entry-note'>客户和材质/配纸保存在纸板批次中；印刷版名和颜色在打印时填写。</Text>
        {field('customerName', '客户')}
        {field('material', '材质 / 配纸')}
        {specificationField('board', '纸板规格尺寸', boardSpecification)}
        {specificationField('carton', '成箱规格尺寸', cartonSpecification)}
        {field('receivedQty', '实收数', true, '张')}
        <View className='stock-entry-grid'>{field('billedArea', '计费平米', true, 'm²')}{field('unitPrice', '每平米单价', true, '元')}</View>
        <Text className='stock-entry-note'>计费平米按送货单填写，货款不按实收张数计算。</Text>
        <View className='stock-entry-field'><Text className='stock-entry-label'>业务日期</Text><Picker disabled={fieldsDisabled} mode='date' value={form.date} end={today()} onChange={e => change('date', e.detail.value)}><View className='board-input-wrap' aria-label='业务日期'>{form.date}</View></Picker></View>
        <View className='board-detail-row'><Text>本批货款</Text><strong>{amount == null ? '金额未记录' : Number.isFinite(amount) ? '¥ ' + amount.toFixed(2) : '金额超出范围'}</strong></View>
      </View>
      <Button className='stock-entry-more' disabled={fieldsDisabled} aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>更多信息 <Text>{moreOpen ? '收起 −' : '展开 ＋'}</Text></Button>
      {moreOpen && <View className='stock-entry-section'>
        {field('freight', '本次运费', true, '元')}
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
      {pending.map((row, index) => <View className='stock-entry-section' key={row.key}><Text>待入库 {index + 1}：{row.data.boardLength} × {row.data.boardWidth} cm · {row.data.receivedQty} 张</Text><Button className='stock-entry-secondary' disabled={fieldsDisabled} onClick={() => setPending(rows => rows.filter(item => item.key !== row.key))}>移除</Button></View>)}
      {!editingId && <Button className='stock-entry-secondary' disabled={fieldsDisabled} onClick={addNext}>再添加一项</Button>}
      {pending.length > 0 && <Text className='stock-entry-note'>本单已选 {pending.length} 项；货款合计 {Number.isFinite(amount) ? '¥ ' + (pending.reduce((sum, row) => sum + Math.round(Number(row.data.billedArea) * Number(row.data.unitPrice) * 100) / 100, 0) + (amount ?? 0)).toFixed(2) : amount == null ? '¥ ' + pending.reduce((sum, row) => sum + Math.round(Number(row.data.billedArea) * Number(row.data.unitPrice) * 100) / 100, 0).toFixed(2) : '金额超出范围'}；运费单独列示</Text>}
      <Button className='stock-entry-primary' disabled={fieldsDisabled} onClick={save}>{busy ? '正在保存…' : editingId ? '保存修改' : '确认入库 · 生成批次标签'}</Button>
    </View>
  </StockEntryLayout>;
}
