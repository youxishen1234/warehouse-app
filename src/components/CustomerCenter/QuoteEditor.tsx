/* eslint-disable react/forbid-elements */
import { useEffect, useRef, useState } from 'react';
import { DemoSheet, DemoField } from '@/components/DemoUI';
import Taro from '@tarojs/taro';
import { getCustomer, getSupplier, updateCustomer, updateSupplier } from '@/services/api';
import { session, watchSession } from '@/services/session';
import { formatDimensionInput } from '@/utils/dimension-input';
import type { Customer, CustomerSpec } from '@/types';
import { appendCustomerSpecQuote, sameCustomerSpecQuote } from './model';
import type { CustomerSpecView } from './model';


type Props = { customer: Customer; supplier?: boolean; seed?: CustomerSpecView; onClose: () => void; onSaved: () => void | Promise<void> };
type Kind = '成品' | '纸板';
type Category = '纸箱' | '纸板' | '其他';
const boardFieldLabels = { boardLength: '纸板长', boardWidth: '纸板宽', cartonLength: '成箱长', cartonWidth: '成箱宽', cartonHeight: '成箱高', fluteType: '楞型', layers: '层数' } as const;
const boardFields = Object.keys(boardFieldLabels) as Array<keyof typeof boardFieldLabels>;
type BoardField = keyof typeof boardFieldLabels;
type Draft = { goods: string; size: string; sizeUnit: 'cm' | 'mm'; kind: Kind; category: Category; material: string; unit: string; price: string } & Record<BoardField, string>;

const identityNow = () => {
  const current = session();
  return current ? JSON.stringify([current.token, current.user.id, current.user.role, !!current.user.disabled]) : '';
};
const writableNow = () => {
  const current = session();
  return !!current && current.user.role !== 'viewer' && !current.user.disabled;
};
const sizeParts = (value: string) => {
  const match = String(value || '').trim().match(/\s*(cm|mm)\s*$/i);
  return { size: match ? value.trim().slice(0, match.index).trim() : String(value || '').trim(),
    sizeUnit: (match?.[1]?.toLowerCase() === 'mm' ? 'mm' : 'cm') as 'cm' | 'mm' };
};
const normalizeSize = (value: string) => String(value || '').trim()
  .replace(/[xX*＊✕乘]/g, '×').replace(/\s*×\s*/g, '×').replace(/\s+/g, '');
const validDimensions = (value: string, kind: Kind) => {
  const sides = normalizeSize(value).split('×');
  const maximum = kind === '纸板' ? 2 : 3;
  return sides.length >= 2 && sides.length <= maximum && sides.every(side => {
    if (!/^\d+(?:\.\d+)?$/.test(side)) return false;
    const length = Number(side);
    return Number.isFinite(length) && length > 0;
  });
};
const quoteDimensionInput = (value: string, previous: string, kind: Kind, sizeUnit: 'cm' | 'mm') => {
  const explicit = /[×xX*＊✕乘]/.test(value);
  const normalized = normalizeSize(value);
  // A pasted or replaced complete size keeps the sides the user entered.
  if (explicit && validDimensions(normalized, kind)) return normalized;
  return formatDimensionInput(value, previous, { sizeUnit, kind });
};

export default function QuoteEditor({ customer, supplier = false, seed, onClose, onSaved }: Props) {
  const hasExisting = seed?.quoteId !== undefined;
  const record = hasExisting ? seed?.record : undefined;
  const openedIdentity = useRef(identityNow());
  const [identity, setIdentity] = useState(openedIdentity.current);
  const invalidated = useRef(false);
  const mounted = useRef(true);
  const lock = useRef(false);
  const generation = useRef(0);
  const newQuoteId = useRef(`customer-spec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const initialSize = sizeParts(seed?.specification || '');
  const [draft, setDraft] = useState<Draft>({
    goods: seed?.goods || '', size: initialSize.size, sizeUnit: initialSize.sizeUnit,
    kind: seed?.kind || '成品', category: seed?.category || (seed?.kind === '纸板' ? '纸板' : '纸箱'),
    material: seed?.material || '', unit: seed?.unit || '',
    price: seed?.price == null ? '' : String(seed.price),
    ...Object.fromEntries(boardFields.map(key => [key, String(record?.[key] ?? '')])) as Record<BoardField, string>
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writable = writableNow() && !invalidated.current && identity === openedIdentity.current && identityNow() === openedIdentity.current;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  useEffect(() => watchSession(() => {
    const next = identityNow();
    if (next === openedIdentity.current || invalidated.current) return;
    invalidated.current = true;
    generation.current += 1;
    setIdentity(next);
    setError('账号已变化，请关闭规格编辑后重新打开');
  }), []);

  const save = async () => {
    const saveIdentity = openedIdentity.current;
    const saveGeneration = generation.current;
    const isCurrent = () => mounted.current && !invalidated.current && generation.current === saveGeneration
      && identityNow() === saveIdentity;
    if (lock.current || !isCurrent() || !writableNow()) {
      setError('当前账号没有编辑权限或账号已变化');
      return;
    }
    const goods = draft.goods.trim();
    const size = draft.size.trim().replace(/\s*(?:[×xX*＊✕]|乘)\s*/g, '×');
    const priceText = draft.price.trim();
    const unchangedPrice = !!record && priceText === String(record.price);
    const originalSize = sizeParts(seed?.specification || '');
    const unchangedLegacySize = !!record && normalizeSize(size) === normalizeSize(originalSize.size)
      && draft.sizeUnit === originalSize.sizeUnit && draft.kind === (record.kind || '成品');
    const hasBoardField = supplier && draft.category === '纸板' && boardFields.some(key => draft[key].trim());
    if (![goods, size, draft.material.trim(), draft.unit.trim(), priceText].some(Boolean) && !hasBoardField) {
      setError('至少填写一项货物资料，不能保存完全空白记录'); return;
    }
    if (goods.length > 100) { setError('货物名称最多100字'); return; }
    if (size.length > 90) { setError('尺寸最多90字'); return; }
    if (draft.unit.trim().length > 10) { setError('单位最多10字'); return; }
    if (draft.material.length > 100) { setError('材质最多100字'); return; }
    if (priceText && ((!unchangedPrice && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(priceText))
      || !Number.isFinite(Number(priceText)) || Number(priceText) < 0)) {
      setError('常用单价须为有限非负数');
      return;
    }
    for (const key of Object.keys(boardFieldLabels) as BoardField[]) {
      if (key === 'fluteType' || !draft[key].trim()) continue;
      const number = Number(draft[key]);
      if (!Number.isFinite(number) || number <= 0 || (key === 'layers' && !Number.isInteger(number))) {
        setError(`${boardFieldLabels[key]}须为${key === 'layers' ? '正整数' : '大于零的数字'}`); return;
      }
    }
    const specification = !size ? '' : unchangedLegacySize ? record!.specification : `${size} ${draft.sizeUnit}`;
    if (specification.length > 100) { setError('尺寸规格最多100字'); return; }
    const source = seed?.source ? { customer_id: seed.source.customerId, spec_id: seed.source.specId } : undefined;
    const submitted: CustomerSpec = {
      ...record,
      id: hasExisting ? seed!.quoteId! : newQuoteId.current, goods, specification,
      material: draft.material.trim(), unit: draft.unit.trim(),
      price: priceText ? (unchangedPrice ? record!.price : Number(priceText)) : null,
      kind: draft.category === '纸板' ? '纸板' : '成品', category: draft.category,
      ...(supplier && draft.category === '纸板' ? Object.fromEntries((Object.keys(boardFieldLabels) as BoardField[]).map(key =>
        [key, key === 'fluteType' ? draft[key].trim() : draft[key].trim() ? Number(draft[key]) : null])) : {}),
      ...(supplier ? { unitPrice: draft.category === '纸板' && priceText ? Number(priceText) : null } : {}),
      ...(source ? { dimension_source: source } : {})
    };
    lock.current = true; setSaving(true); setError('');
    try {
      const latest = await (supplier ? getSupplier(customer.id) : getCustomer(customer.id, { forceNetwork: true }));
      if (!isCurrent()) return;
      if (!latest || latest.id !== customer.id || latest.deleted_at) throw new Error('客户资料已删除或变化，请刷新后重试');
      const specs = Array.isArray(latest.specs) ? latest.specs : [];
      let nextSpecs: CustomerSpec[];
      if (hasExisting) {
        const target = specs.find(spec => spec.id === seed!.quoteId);
        if (!target || !record) throw new Error('此规格已被另一端修改或删除，草稿已保留；请刷新后重新编辑');
        if (sameCustomerSpecQuote(target, submitted)) {
          void Taro.showToast({ title: '规格已保存', icon: 'success' });
          await onSaved(); return;
        }
        if (!sameCustomerSpecQuote(target, record)) throw new Error('此规格已被另一端修改或删除，草稿已保留；请刷新后重新编辑');
        nextSpecs = specs.map(spec => spec.id === seed!.quoteId ? submitted : spec);
      } else {
        const retry = specs.find(spec => spec.id === newQuoteId.current);
        if (retry) {
          if (!sameCustomerSpecQuote(retry, submitted)) throw new Error('此规格已变化，草稿已保留；请刷新后重试');
          void Taro.showToast({ title: '规格已保存', icon: 'success' });
          await onSaved(); return;
        }
        if (source && specs.some(spec => spec.dimension_source?.customer_id === source.customer_id
          && spec.dimension_source.spec_id === source.spec_id)) {
          throw new Error('此尺寸本规格已被另一端报价，草稿已保留；请刷新后重新编辑');
        }
        nextSpecs = appendCustomerSpecQuote(specs, submitted).specs;
      }
      if (!isCurrent()) return;
      await (supplier ? updateSupplier(customer.id, { specs: nextSpecs }) : updateCustomer(customer.id, { specs: nextSpecs }));
      if (!isCurrent()) return;
      void Taro.showToast({ title: '规格已保存', icon: 'success' });
      await onSaved();
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : '保存失败，请重试');
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const input = (key: 'goods' | 'material' | 'unit' | 'price', label: string, aria: string, limit: number) => <DemoField label={label}><input aria-label={aria} type={key === 'price' ? 'number' : 'text'} maxLength={limit} value={draft[key]} disabled={saving || !writable} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} /></DemoField>;
  return <DemoSheet title={seed ? '编辑常用货物' : '添加常用货物'} onClose={onClose} busy={saving} testId='customer-quote-editor'>
    <p>保存货名、规格和参考单价，下次直接选择。历史单据保留原价格。</p>
    {input('goods', '货物名称', '规格货物', 100)}
    <DemoField label='尺寸 / 规格'><input aria-label='规格尺寸' maxLength={90} value={draft.size} disabled={saving || !writable} onChange={event => setDraft(current => ({ ...current, size: quoteDimensionInput(event.target.value, current.size, current.kind, current.sizeUnit) }))} /></DemoField>
    {input('material', '材质 / 楞型', '规格材质', 100)}
    {input('price', '参考单价（元 / ' + (draft.unit || '个') + '）', '规格常用单价', 20)}
    <details className='demo-more'><summary>单位与类别</summary>
      <div className='demo-two'><DemoField label='尺寸单位'><select aria-label='尺寸单位' value={draft.sizeUnit} disabled={saving || !writable} onChange={event => setDraft(current => ({ ...current, sizeUnit: event.target.value as 'cm' | 'mm' }))}>{['cm', 'mm'].map(value => <option key={value}>{value}</option>)}</select></DemoField><DemoField label='类别'><select aria-label='货物类别' value={draft.category} disabled={saving || !writable} onChange={event => { const category = event.target.value as Category; setDraft(current => ({ ...current, category, kind: category === '纸板' ? '纸板' : '成品' })); }}>{['纸箱', '纸板', '其他'].map(value => <option key={value}>{value}</option>)}</select></DemoField></div>
      {input('unit', '单位', '规格单位', 10)}
      {supplier && draft.category === '纸板' && boardFields.map(key => <DemoField label={boardFieldLabels[key]} key={key}><input aria-label={`规格${boardFieldLabels[key]}`} type={key === 'fluteType' ? 'text' : 'number'} value={draft[key]} disabled={saving || !writable} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></DemoField>)}
    </details>
    {!writable && <p>当前账号仅可查看规格</p>}
    {error && <div role='alert' className='demo-error'>{error}</div>}
    <button type='button' className='demo-primary' data-testid='customer-quote-save' disabled={saving || !writable} onClick={() => void save()}>{saving ? '保存中…' : '保存常用货物'}</button>
  </DemoSheet>;
}
