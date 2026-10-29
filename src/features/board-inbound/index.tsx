import { useCallback, useEffect, useRef, useState } from 'react';
/* eslint-disable react/forbid-elements */
import Taro, { useLoad, useRouter } from '@tarojs/taro';
import { DemoSheet, DemoField, DemoDetail } from '@/components/DemoUI';
import type { PartyGood } from '@/components/PartySearchPanel';
import { getSuppliers } from '@/services/api';
import type { Supplier } from '@/types';
import { BoardBatch, getBoards, getBoard, receiveBoard, receiveBoards, updateBoard, boardSpec, today } from '@/services/boards';
import { BusinessSpecification, getBusinessSpecifications } from '@/services/business-workflow';
import { useSharedRefresh } from '@/services/shared-refresh';
import { watchSession } from '@/services/session';
import { formatSpecificationInput } from '@/pages/print-center/specification-input';
import { parseDimensionSpecification, preserveDimensionGrouping, shouldPreserveDimensionGrouping, specificationFromDimensions } from '@/features/board-inbound/specification-input';

const localEntryTime = () => { const now = new Date(); return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; };
const initial = { name: '纸板', enteredAt: '', supplier: '', customerName: '', material: '', printPlate: '', printColor: '', date: today(), boardLength: '', boardWidth: '', cartonLength: '', cartonWidth: '', cartonHeight: '', fluteType: 'BC', layers: '5', faceGsm: '', linerGsm: '', flutingGsm: '', orderedQty: '', receivedQty: '', billedArea: '', unitPrice: '', freight: '', warningQty: '0', location: '', deliveryNo: '', remark: '' };
type BoardDraft = Record<string, string | number | boolean | null>;
export default function BoardReceive() {
  const { params: entryParams } = useRouter();
  const prefillApplied = useRef(false);
  const [form, setForm] = useState(() => ({ ...initial, enteredAt: `${today()}T${localEntryTime()}`, date: today() })); const [selected, setSelected] = useState<BoardBatch | null>(null); const [templates, setTemplates] = useState<BoardBatch[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const saving = useRef(false);
  const [boardSpecification, setBoardSpecification] = useState('');
  const [cartonSpecification, setCartonSpecification] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [saveSupplierSpec, setSaveSupplierSpec] = useState(true);

  const [customerSource, setCustomerSource] = useState('');
  const [sharedSpecId, setSharedSpecId] = useState('');

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(() => entryParams.supplier_id && /^[1-9]\d*$/.test(entryParams.supplier_id) ? Number(entryParams.supplier_id) : null);
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
    setManualAmount('');
    const text = (value: unknown) => value == null ? '' : String(value);
    setBoardSpecification(spec.boardLength && spec.boardWidth ? specificationFromDimensions([spec.boardLength, spec.boardWidth]) : spec.specification || '');
    setCartonSpecification(spec.cartonLength && spec.cartonWidth && spec.cartonHeight ? specificationFromDimensions([spec.cartonLength, spec.cartonWidth, spec.cartonHeight]) : '');
    setForm(f => ({ ...f, boardLength: text(spec.boardLength), boardWidth: text(spec.boardWidth), cartonLength: text(spec.cartonLength), cartonWidth: text(spec.cartonWidth), cartonHeight: text(spec.cartonHeight), name: spec.goods || '纸板', material: spec.material || '', fluteType: spec.fluteType || '', layers: text(spec.layers), unitPrice: text(spec.unitPrice ?? spec.price) }));
  };
  useEffect(() => {
    if (prefillApplied.current || !entryParams.spec_id || !supplier || draftChanged.current) return;
    const spec = supplierSpecs.find(item => item.id === entryParams.spec_id);
    if (spec) { applySupplierSpec(spec); prefillApplied.current = true; }
  }, [supplier, supplierSpecs, entryParams.spec_id]);
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
    setSelected(null);
    setManualAmount('');
    const boardSize = spec.board ? specificationFromDimensions(spec.board) : '';
    const cartonSize = spec.carton ? specificationFromDimensions(spec.carton) : '';
    setBoardSpecification(boardSize);
    setCartonSpecification(cartonSize);
    setForm(f => ({ ...f, name: spec.name || f.name, customerName: spec.customer_name || f.customerName, material: spec.material || f.material, ...(spec.board ? { boardLength: String(spec.board[0]), boardWidth: String(spec.board[1]) } : { boardLength: '', boardWidth: '' }), ...(spec.carton ? { cartonLength: String(spec.carton[0]), cartonWidth: String(spec.carton[1]), cartonHeight: String(spec.carton[2]) } : { cartonLength: '', cartonWidth: '', cartonHeight: '' }), ...(spec.fluteType ? { fluteType: spec.fluteType } : {}), ...(spec.layers ? { layers: String(spec.layers) } : {}) }));
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
  const fill = useCallback((b: BoardBatch) => { if (saving.current) return; draftChanged.current = true; orderedQuantityEdited.current = false; setSelected(b);  setManualAmount(''); setError(''); setBoardSpecification(b.boardDimensionsPending ? '' : specificationFromDimensions([b.boardLength, b.boardWidth])); setCartonSpecification(specificationFromDimensions([b.cartonLength, b.cartonWidth, b.cartonHeight])); setForm(() => { const next = { ...initial, enteredAt: `${today()}T${localEntryTime()}`, date: today() }; for (const k of ['name', 'customerName', 'material', 'boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight', 'fluteType', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm', 'unitPrice', 'warningQty', 'location']) next[k] = String(b[k] ?? (k === 'name' ? '纸板' : '')); return next; }); }, []);
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
          if (editing) { setSupplierId(editing.supplier_id ?? null); orderedQuantityEdited.current = true; setBoardSpecification(editing.boardDimensionsPending ? '' : specificationFromDimensions([editing.boardLength, editing.boardWidth])); setManualAmount(editing.amountMode === 'manual' ? String(editing.amount) : ''); setCartonSpecification(specificationFromDimensions([editing.cartonLength, editing.cartonWidth, editing.cartonHeight])); setForm({ ...Object.fromEntries(Object.keys(initial).map(k => [k, String(editing[k] ?? (k === 'name' ? '纸板' : k === 'enteredAt' ? `${editing.date}T00:00` : ''))])), ...(editing.amountMode === 'pending' ? { billedArea: '', unitPrice: '' } : {}) } as typeof initial); }
          else if (params.from) { const batch = rows.find(b => b.id === params.from); if (batch) fill(batch); }
        }
        if (params.id) setEditReady(true);
      }
    } catch (e) { if (mounted.current && current === boardSequence.current) setBoardLoadError(e.message || '入库资料读取失败'); }
  }, [fill]);
  useSharedRefresh(() => { void loadSpecs(); void loadBoards(); void loadSuppliers(); });
  useEffect(() => watchSession(() => { void loadSpecs(); void loadBoards(); void loadSuppliers(); }), [loadSpecs, loadBoards, loadSuppliers]);
  useLoad(params => { routeParams.current = { id: params.id || '', from: params.from || '' }; setEditingId(params.id || ''); setEditReady(!params.id); void loadBoards(); });
  const field = (key: keyof typeof initial, label: string, numeric = false, unit?: string) => <DemoField label={label + (unit ? `（${unit}）` : '')} key={key}><input type={numeric ? 'number' : 'text'} disabled={fieldsDisabled} aria-label={label} step={numeric ? 'any' : undefined} value={form[key]} onChange={event => change(key, event.target.value)} maxLength={key === 'remark' ? 500 : 120} /></DemoField>;
  const specificationField = (kind: 'board' | 'carton', label: string, value: string) => <DemoField label={label + '（cm）'}><input type='text' aria-label={label} disabled={fieldsDisabled} value={value} onChange={event => changeSpecification(kind, event.target.value)} /></DemoField>;
  const options = (key: string) => [...new Set(allRows.map(b => String(b[key] || '')).filter(Boolean))];
  const selectField = (key: keyof typeof initial, label: string, choices: string[]) => <DemoField label={label}><select aria-label={label} disabled={fieldsDisabled} value={form[key]} onChange={event => change(key, event.target.value)}><option value=''>请选择{label}</option>{Array.from(new Set([...(form[key] ? [form[key]] : []), ...choices])).map(value => <option key={value} value={value}>{key === 'layers' ? ({ '3': '三层', '5': '五层', '7': '七层' }[value] || `${value}层`) : value}</option>)}</select></DemoField>;
  const matches = templates.filter(b => [boardSpec(b), b.supplier, b.fluteType, b.layers + '层'].join(' ').toLowerCase().replace(/[ ×x*]/g, '').includes(templateQuery.toLowerCase().replace(/[ ×x*]/g, '')));
  const gift = Math.max(0, Number(form.receivedQty) - Number(form.orderedQty)); const shortage = Math.max(0, Number(form.orderedQty) - Number(form.receivedQty));
  const calculatedArea = Number(form.boardLength) > 0 && Number(form.boardWidth) > 0 && Number(form.receivedQty) > 0 ? Math.round(Number(form.boardLength) * Number(form.boardWidth) / 10000 * Number(form.receivedQty) * 10000) / 10000 : null;
  const billedArea = form.billedArea.trim() || (calculatedArea == null ? '' : String(calculatedArea));
  const amount = manualAmount.trim() ? Number(manualAmount) : billedArea && form.unitPrice.trim() ? Number(billedArea) * Number(form.unitPrice) : null;
  const pendingTotal = pending.reduce((sum, row) => sum + (row.data.amountMode === 'pending' ? 0 : row.data.amountMode === 'manual' ? Number(row.data.manualAmount) : Math.round(Number(row.data.billedArea) * Number(row.data.unitPrice) * 100) / 100), 0);
  const currentDraft = (): BoardDraft => {
    const boardDimensions = parseDimensionSpecification(boardSpecification, 2);
    if (boardSpecification.trim() && !boardDimensions) throw new Error('纸板规格尺寸请填写完整的长×宽，或留空稍后补充');
    const cartonDimensions = parseDimensionSpecification(cartonSpecification, 3);
    if (!cartonDimensions) throw new Error('成箱规格尺寸请填写完整的长×宽×高，且均为正数');
    if (supplierId != null && !supplier) throw new Error('所选供货商已停用，请重新选择');
    const required: [keyof typeof initial, string][] = [['orderedQty', '订购数'], ['receivedQty', '实收数']];
    for (const [key, label] of required) if (!form[key].trim()) throw new Error('请填写' + label);
    if (manualAmount.trim() && (!Number.isFinite(Number(manualAmount)) || Number(manualAmount) < 0)) throw new Error('请核对本批金额');
    if (!form.name.trim()) throw new Error('请填写纸板名称');
    return { ...form, save_supplier_spec: Boolean(supplier && saveSupplierSpec && !editingId), supplier_id: supplierId, supplier: supplier?.name || '', boardLength: boardDimensions?.[0] || 0, boardWidth: boardDimensions?.[1] || 0, ...(!boardDimensions ? { boardDimensionsPending: true } : {}), cartonLength: cartonDimensions[0], cartonWidth: cartonDimensions[1], cartonHeight: cartonDimensions[2], billedArea: billedArea || '0', unitPrice: form.unitPrice || '0', amountMode: manualAmount.trim() ? 'manual' : amount == null ? 'pending' : 'area', manualAmount: manualAmount.trim() || '0', freight: form.freight || '0', faceGsm: form.faceGsm || '0', linerGsm: form.linerGsm || '0', flutingGsm: form.flutingGsm || '0' };
  };
  const addNext = () => {
    if (saving.current) return;
    try {
      const data = currentDraft();
      setPending(rows => [...rows, {key: `${Date.now()}-${Math.random()}`, data}]);
      setForm({...initial, supplier: supplier?.name || '', enteredAt: form.enteredAt, date: form.date});
      setBoardSpecification(''); setCartonSpecification(''); setManualAmount(''); setSelected(null); orderedQuantityEdited.current = false; draftChanged.current = false; setError('');
    } catch (e) { setError(e.message); }
  };
  const changeSupplier = async (id: number | null) => {
    if (saving.current || id === supplierId) return;
    if (pending.length || draftChanged.current) {
      const confirmation = await Taro.showModal({ title: '改变本单关联对象', content: '更改供货商会改变本单全部纸板的关联对象，并清空已选规格和待入库明细。请确认。' });
      if (!confirmation.confirm) return;
      setPending([]); setForm({...initial, date: form.date}); setBoardSpecification(''); setCartonSpecification(''); setManualAmount('');
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
      Taro.redirectTo({ url: '/pages/management/index?section=paperboard-batch&id=' + b.id + (editingId ? '' : '&received=1') });
    } catch (e) { setError(e.message); } finally { saving.current = false; setBusy(false); }
  };
  const customerNames = Array.from(new Set(sharedSpecs.filter(spec => spec.source === 'customer' && spec.customer_name).map(spec => spec.customer_name as string)));
  const customerGoods = sharedSpecs.filter(spec => spec.source === 'customer' && spec.customer_name === customerSource);
  return <DemoSheet title={editingId ? '编辑纸板入库' : '自定义纸板入库'} busy={busy} testId='paperboard-receipt-sheet'>
    <p>先选客户常用资料，已有纸板尺寸直接带入；也可填写新规格。</p>
    {boardLoadError && <div className='demo-error' role='alert'>{boardLoadError}<button type='button' className='demo-action' onClick={() => void loadBoards()}>重新读取</button></div>}
    {editingId && !editReady && !boardLoadError && <p role='status'>正在读取原入库单…</p>}
    <DemoField label='客户资料（选填）'><select aria-label='客户资料' value={customerSource} disabled={fieldsDisabled} onChange={event => { setCustomerSource(event.target.value); change('customerName', event.target.value); setSharedSpecId(''); }}><option value=''>不引用客户资料</option>{customerNames.map(name => <option key={name}>{name}</option>)}</select></DemoField>
    <DemoField label='客户常用货物'><select aria-label='客户常用货物' value={sharedSpecId} disabled={fieldsDisabled || !customerSource} onChange={event => { setSharedSpecId(event.target.value); const spec = customerGoods.find(item => item.id === event.target.value); if (spec) applySharedSpec(spec); }}><option value=''>{customerSource ? '选择客户货物' : '先选择客户'}</option>{customerGoods.map(spec => <option key={spec.id} value={spec.id}>{spec.name} · {(spec.carton || spec.board || []).join(' × ')} cm</option>)}</select></DemoField>
    {specError && <div className='demo-error' role='alert'>{specError}<button type='button' className='demo-action' onClick={() => void loadSpecs()}>重新读取</button></div>}
    <div className='demo-note'>成箱尺寸与纸板尺寸不同；没有纸板尺寸时需核对后补充一次。</div>
    <DemoField label='供货商（选填）'><select aria-label='供货商' value={supplierId || ''} disabled={fieldsDisabled} onChange={event => void changeSupplier(Number(event.target.value) || null)}><option value=''>不关联供货商 · 只登记库存</option>{suppliers.filter(item => !item.deleted_at).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></DemoField>
    {supplierError && <div className='demo-error' role='alert'>{supplierError}<button type='button' className='demo-action' onClick={() => void loadSuppliers()}>重新读取</button></div>}
    {!!supplierSpecs.length && <DemoField label='供货商常购规格'><select aria-label='供货商常购规格' disabled={fieldsDisabled} defaultValue='' onChange={event => { const spec = supplierSpecs.find(item => item.id === event.target.value); if (spec) applySupplierSpec(spec); }}><option value=''>选择常购规格</option>{supplierSpecs.map(spec => <option key={spec.id} value={spec.id}>{spec.goods} · {spec.specification}</option>)}</select></DemoField>}
    {specificationField('carton', '纸箱尺寸：长 × 宽 × 高', cartonSpecification)}
    {field('name', '纸板名称（必填）')}
    <details className='demo-more'><summary>采购纸板尺寸 · 查看 / 调整</summary><p>已有对应纸板尺寸会自动带出。可以不填，先登记库存；面积和金额标记待核算，补齐前不增加应付。</p><div className='demo-two'>{(['boardLength', 'boardWidth'] as const).map((key, index) => <DemoField key={key} label={`实际纸板${index ? '宽' : '长'}（cm，选填）`}><input type='number' step='any' min='0' aria-label={`实际纸板${index ? '宽' : '长'}`} disabled={fieldsDisabled} value={form[key]} onChange={event => { const value = event.target.value; change(key, value); const length = key === 'boardLength' ? value : form.boardLength; const width = key === 'boardWidth' ? value : form.boardWidth; setBoardSpecification(length || width ? `${length} × ${width}` : ''); }} /></DemoField>)}</div></details>
    <div className='demo-two'>{selectField('layers', '层数', ['3', '5', '7'])}{field('fluteType', '楞型（可自定义）')}</div>
    {field('material', '材质 / 配纸（选填）')}
    <div className='demo-two'>{field('receivedQty', '实收数', true, '张')}{field('unitPrice', '每平米单价', true, '元 / ㎡')}</div>
    {field('location', '库位（选填）')}
    <DemoField label='本次入库总金额（元，可直接填送货单金额）'><input type='number' step='0.01' min='0' aria-label='本批金额' value={manualAmount} disabled={fieldsDisabled} onChange={event => { draftChanged.current = true; setManualAmount(event.target.value); }} /></DemoField>
    <p className='demo-meta'>有纸板面积时自动计算；没有面积也可直接填写总金额，按该金额登记供货商应付。</p>
    <DemoField label='入库日期时间'><input type='datetime-local' aria-label='入库日期时间' value={form.enteredAt || `${form.date}T00:00`} max={`${today()}T23:59`} disabled={fieldsDisabled} onChange={event => { change('enteredAt', event.target.value); change('date', event.target.value.slice(0, 10)); }} /></DemoField>
    {field('deliveryNo', '送货单号（选填）')}
    <div className='demo-note' data-testid='board-cost-preview'>面积与金额：{calculatedArea == null ? '填写纸板长宽、数量及每平方米单价后自动计算。' : `${calculatedArea} ㎡`}{amount != null && Number.isFinite(amount) ? ` · ¥ ${amount.toFixed(2)}` : ' · 金额待核算'}</div>
    <label className='demo-checkbox'><input type='checkbox' checked={saveSupplierSpec} disabled={fieldsDisabled || Boolean(editingId)} onChange={event => setSaveSupplierSpec(event.target.checked)} />保存为该供货商常购规格</label>
    <p className='demo-meta'>入库总金额优先使用手填金额，否则按面积计算；有金额并关联供货商时增加应付。实际付款单独登记。</p>
    <details className='demo-more'><summary>选择已有规格</summary><DemoField label='搜索规格'><input type='search' aria-label='搜索规格' disabled={fieldsDisabled} value={templateQuery} onChange={event => setTemplateQuery(event.target.value)} /></DemoField>{sharedSpecs.filter(spec => spec.source !== 'board' && [spec.name, spec.material, ...(spec.carton || spec.board || [])].join(' ').toLowerCase().includes(templateQuery.toLowerCase())).map(spec => <button type='button' className='demo-card' key={spec.id} disabled={fieldsDisabled} onClick={() => applySharedSpec(spec)}>{spec.name} · {(spec.carton || spec.board || []).join(' × ')} cm</button>)}{matches.map(batch => <button type='button' className='demo-card' key={batch.id} disabled={fieldsDisabled} onClick={() => fill(batch)}>{boardSpec(batch)} cm · {batch.supplier}</button>)}{selected && <p>已带入历史规格，本次另建新批次。</p>}</details>
    <details className='demo-more'><summary>更多信息</summary>{field('customerName', '客户')}{field('billedArea', '计费平米', true, '㎡')}{field('freight', '本次运费', true, '元')}{field('orderedQty', '订购数', true, '张')}{form.orderedQty && form.receivedQty && <p>{gift ? `多送 ${gift} 张` : shortage ? `少送 ${shortage} 张` : '实收与订购数量一致'}</p>}<div className='demo-two'>{field('faceGsm', '面纸克重', true)}{field('linerGsm', '里纸克重', true)}{field('flutingGsm', '楞纸克重', true)}{selectField('location', '已有库位', options('location'))}</div>{field('warningQty', '规格预警线', true, '张')}{field('remark', '备注')}
      {pending.map((row, index) => <DemoDetail key={row.key} label={`待入库 ${index + 1}`}><span>{row.data.receivedQty} 张 <button type='button' className='demo-action' disabled={fieldsDisabled} onClick={() => setPending(rows => rows.filter(item => item.key !== row.key))}>移除</button></span></DemoDetail>)}
      {!editingId && <button type='button' className='demo-primary demo-secondary' disabled={fieldsDisabled} onClick={addNext}>再添加一项</button>}
      {pending.length > 0 && <p>已选 {pending.length} 项 · 已知货款 ¥ {(pendingTotal + (amount ?? 0)).toFixed(2)}</p>}
    </details>
    {error && <div className='demo-error' role='alert'>{error}</div>}
    <button type='button' className='demo-primary' disabled={fieldsDisabled} onClick={() => void save()}>{busy ? '正在保存…' : editingId ? '保存修改' : '确认纸板入库'}</button>
  </DemoSheet>;
}
