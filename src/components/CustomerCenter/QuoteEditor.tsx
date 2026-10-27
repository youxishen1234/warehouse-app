import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getCustomer, updateCustomer } from '@/services/api';
import { session, watchSession } from '@/services/session';
import { formatDimensionInput } from '@/utils/dimension-input';
import type { Customer, CustomerSpec } from '@/types';
import { appendCustomerSpecQuote, sameCustomerSpecQuote } from './model';
import type { CustomerSpecView } from './model';
import styles from './index.module.scss';

type Props = { customer: Customer; seed?: CustomerSpecView; onClose: () => void; onSaved: () => void | Promise<void> };
type Kind = '成品' | '纸板';
type Draft = { goods: string; size: string; sizeUnit: 'cm' | 'mm'; kind: Kind; material: string; unit: string; price: string };

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

export default function QuoteEditor({ customer, seed, onClose, onSaved }: Props) {
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
    kind: seed?.kind || '成品', material: seed?.material || '', unit: seed?.unit || '个',
    price: seed?.price == null ? '' : String(seed.price)
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
    if (!goods || goods.length > 100) { setError('请填写货物名称，最多100字'); return; }
    if (!size || size.length > 90) { setError('请填写尺寸，最多90字'); return; }
    if (!unchangedLegacySize && !validDimensions(size, draft.kind)) {
      setError(draft.kind === '纸板' ? '纸板尺寸须为两个大于零的数字' : '成品尺寸须为两个或三个大于零的数字');
      return;
    }
    if (!draft.unit.trim() || draft.unit.trim().length > 10) { setError('请填写单位，最多10字'); return; }
    if (draft.material.length > 100) { setError('材质最多100字'); return; }
    if (!priceText || (!unchangedPrice && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(priceText))
      || !Number.isFinite(Number(priceText)) || Number(priceText) < 0) {
      setError('常用单价必填，须为有限非负数');
      return;
    }
    const specification = unchangedLegacySize ? record!.specification : `${size} ${draft.sizeUnit}`;
    if (specification.length > 100) { setError('尺寸规格最多100字'); return; }
    const source = seed?.source ? { customer_id: seed.source.customerId, spec_id: seed.source.specId } : undefined;
    const submitted: CustomerSpec = {
      id: hasExisting ? seed!.quoteId! : newQuoteId.current, goods, specification,
      material: draft.material.trim(), unit: draft.unit.trim(),
      price: unchangedPrice ? record!.price : Number(priceText), kind: draft.kind,
      ...(source ? { dimension_source: source } : {})
    };
    lock.current = true; setSaving(true); setError('');
    try {
      const latest = await getCustomer(customer.id, { forceNetwork: true });
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
      await updateCustomer(customer.id, { specs: nextSpecs });
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

  const dialog = <View className={styles.quoteMask} onClick={() => { if (!saving) onClose(); }}>
    <View role='dialog' aria-modal='true' aria-label={seed ? '编辑常用规格' : '新增常用规格'} data-testid='customer-quote-editor'
      className={styles.quoteDialog} onClick={event => event.stopPropagation()}>
      <View className={styles.quoteHeading}><Text>{seed ? '编辑常用规格' : '新增常用规格'}</Text>
        <Button aria-label='关闭规格编辑' disabled={saving} onClick={onClose}>×</Button></View>
      <Text className={styles.quoteCustomer}>{customer.name}</Text>
      <View className={styles.quoteField}><Text>货物</Text><Input aria-label='规格货物' maxlength={100} value={draft.goods}
        disabled={saving || !writable} onInput={event => setDraft(value => ({ ...value, goods: event.detail.value }))} /></View>
      <View className={styles.quoteField}><Text>尺寸</Text><Input aria-label='规格尺寸' maxlength={90} value={draft.size}
        disabled={saving || !writable} onInput={event => setDraft(current => ({ ...current,
          size: quoteDimensionInput(event.detail.value, current.size, current.kind, current.sizeUnit) }))} />
        <View className={styles.quoteChoices}>{(['cm', 'mm'] as const).map(value =>
          <Button key={value} aria-pressed={draft.sizeUnit === value}
            className={draft.sizeUnit === value ? styles.quoteChoiceActive : styles.quoteChoice}
            disabled={saving || !writable} onClick={() => setDraft(current => ({ ...current, sizeUnit: value }))}>{value}</Button>)}</View></View>
      <View className={styles.quoteField}><Text>类别</Text><View className={styles.quoteChoices}>{(['成品', '纸板'] as const).map(value =>
        <Button key={value} aria-pressed={draft.kind === value}
          className={draft.kind === value ? styles.quoteChoiceActive : styles.quoteChoice}
          disabled={saving || !writable} onClick={() => setDraft(current => ({ ...current, kind: value }))}>{value}</Button>)}</View></View>
      <View className={styles.quoteField}><Text>材质</Text><Input aria-label='规格材质' maxlength={100} value={draft.material}
        disabled={saving || !writable} onInput={event => setDraft(value => ({ ...value, material: event.detail.value }))} /></View>
      <View className={styles.quoteField}><Text>单位</Text><Input aria-label='规格单位' maxlength={10} value={draft.unit}
        disabled={saving || !writable} onInput={event => setDraft(value => ({ ...value, unit: event.detail.value }))} /></View>
      <View className={styles.quoteField}><Text>常用单价（必填）</Text><Input aria-label='规格常用单价' type='digit' maxlength={20}
        value={draft.price} disabled={saving || !writable}
        onInput={event => setDraft(value => ({ ...value, price: event.detail.value }))} />
        <Text className={styles.quoteHint}>有限非负数，可保留实际小数精度</Text></View>
      {!writable && <Text className={styles.quoteHint}>当前账号仅可查看规格</Text>}
      {error && <View role='alert' className={styles.quoteError}>{error}</View>}
      <View className={styles.quoteActions}><Button disabled={saving} onClick={onClose}>取消</Button>
        <Button className={styles.quoteSave} data-testid='customer-quote-save' disabled={saving || !writable}
          onClick={() => void save()}>{saving ? '保存中…' : '保存规格'}</Button></View>
    </View>
  </View>;
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
