/* eslint-disable react/forbid-elements */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getCustomers, getProducts } from '@/services/api';
import { getCustomerDimensions } from '@/services/customer-dimensions';
import { session, watchSession } from '@/services/session';
import type { ItemDraft } from './model';
import { availableSpecificationSlots, buildSpecificationOptions, filterSpecificationOptions, specificationAlreadyAdded } from './specification-library';
import type { SpecificationOption } from './specification-library';
import styles from './specification-picker.module.scss';

type Props = {
  customerId: number | null;
  customerName: string;
  items: ItemDraft[];
  onAdd: (options: SpecificationOption[]) => void;
  onClose: () => void;
};

const sourceLabel = (option: SpecificationOption) => option.source === 'product' ? '成品库存'
  : `${option.source === 'dimension' ? '客户尺寸本' : '客户常用规格'} · ${option.customer_name}`;
const priceLabel = (price: string) => price !== '' && Number.isFinite(Number(price)) && Number(price) >= 0
  ? `${Number(price).toLocaleString('zh-CN', { maximumFractionDigits: 6 })} 元/个` : '单价待填写';

export default function SpecificationPicker({ customerId, customerName, items, onAdd, onClose }: Props) {
  const hasCustomer = customerId !== null || Boolean(customerName.trim());
  const [scope, setScope] = useState<'customer' | 'all'>(hasCustomer ? 'customer' : 'all');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SpecificationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [waitingSession, setWaitingSession] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [retry, setRetry] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let active = true, sequence = 0;
    const load = async () => {
      const current = ++sequence;
      setOptions([]); setLoadError(''); setActionError('');
      if (!session()) { setWaitingSession(true); setLoading(false); return; }
      setWaitingSession(false); setLoading(true);
      try {
        const [customers, products, dimensions] = await Promise.all([getCustomers(), getProducts(), getCustomerDimensions()]);
        if (active && sequence === current) setOptions(buildSpecificationOptions(customers, products, dimensions.customers));
      } catch (error) {
        if (active && sequence === current) setLoadError(error instanceof Error ? error.message : '规格加载失败，请重试');
      } finally {
        if (active && sequence === current) setLoading(false);
      }
    };
    const unsubscribe = watchSession(() => { void load(); });
    void load();
    return () => { active = false; sequence++; unsubscribe(); };
  }, [retry]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    searchRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener('keydown', handleKey);
    return () => { dialog?.removeEventListener('keydown', handleKey); if (previous?.isConnected) previous.focus(); };
  }, []);

  const filtered = useMemo(() => scope === 'customer' && hasCustomer
    ? filterSpecificationOptions(options, query, customerId ?? undefined, customerName)
    : filterSpecificationOptions(options, query), [options, query, scope, hasCustomer, customerId, customerName]);
  const pending = useMemo(() => {
    // Count the same distinct rows the draft will accept, even across sources.
    const staged = items.slice();
    return filtered.filter(option => {
      if (specificationAlreadyAdded(staged, option)) return false;
      staged.push({ key: `pending-${option.id}`, product_id: option.product_id, name: option.name, specification: option.specification,
        quantity: '', price: option.price, remark: option.material });
      return true;
    });
  }, [filtered, items]);
  const slots = availableSpecificationSlots(items);
  const ready = !loading && !waitingSession && !loadError;
  const add = (selected: SpecificationOption[]) => {
    setActionError('');
    if (selected.length > slots) { setActionError(`本次待添加 ${selected.length} 项，单据还可添加 ${slots} 项；请缩小搜索范围或逐条添加。`); return; }
    if (!selected.length) return;
    try { onAdd(selected); } catch (error) { setActionError(error instanceof Error ? error.message : '添加失败，请重试'); }
  };

  return <div className={styles.pickerBackdrop}>
    <div className={styles.pickerDialog} ref={dialogRef} role='dialog' aria-modal='true' aria-label='搜索并添加规格' tabIndex={-1}>
      <div className={styles.pickerHeader}>
        <h2>搜索并添加规格</h2>
        <button type='button' className={styles.pickerClose} aria-label='关闭规格选择' onClick={onClose}>关闭</button>
      </div>
      <p className={styles.pickerHint}>仅显示数量单位为“个”的规格；数量与未记录单价需填写</p>
      {hasCustomer && <div className={styles.pickerScopes} role='group' aria-label='规格范围'>
        <button type='button' aria-pressed={scope === 'customer'} onClick={() => { setScope('customer'); setActionError(''); }}>当前客户</button>
        <button type='button' aria-pressed={scope === 'all'} onClick={() => { setScope('all'); setActionError(''); }}>全部规格</button>
      </div>}
      <input ref={searchRef} className={styles.pickerSearch} type='search' aria-label='搜索规格' placeholder='产品名称 / 规格尺寸 / 材质 / 客户'
        value={query} onChange={event => { setQuery(event.target.value); setActionError(''); }} />
      <div className={styles.pickerSummary} aria-live='polite'>
        <span>{ready ? `匹配 ${filtered.length} 项 · 待添加 ${pending.length} 项` : '规格库'}</span>
        <span>还可添加 {slots} 项</span>
      </div>
      <div className={styles.pickerResults} aria-busy={loading}>
        {loading && <p className={styles.pickerEmpty} role='status'>正在加载规格…</p>}
        {waitingSession && <p className={styles.pickerEmpty} role='status'>请先登录，登录后将自动加载规格。</p>}
        {loadError && <div className={styles.pickerError} role='alert'><p>规格加载失败：{loadError}</p>
          <button type='button' onClick={() => setRetry(value => value + 1)}>重新加载</button>
        </div>}
        {ready && !filtered.length && <div className={styles.pickerEmpty}>
          <strong>{query.trim() ? '未找到匹配规格' : scope === 'customer' && hasCustomer ? '当前客户暂无可用规格' : '暂无可用规格'}</strong>
          <p>{query.trim() ? '试试其他产品名称、尺寸、材质或客户关键词。' : scope === 'customer' && hasCustomer ? '可切换到“全部规格”，搜索其他客户或成品库存。' : '先在客户尺寸本、客户资料或成品库存中保存规格。'}</p>
        </div>}
        {ready && filtered.map(option => {
          const alreadyAdded = specificationAlreadyAdded(items, option);
          return <div className={styles.pickerOption} key={option.id}>
            <div className={styles.pickerOptionBody}>
              <span className={styles.pickerSource}>{sourceLabel(option)}</span>
              <strong>{option.name || '未命名产品'}</strong>
              <span className={styles.pickerSpecification}>{option.specification}</span>
              <small>材质：{option.material || '未记录'} · {priceLabel(option.price)}</small>
            </div>
            <button type='button' className={styles.pickerAdd} disabled={alreadyAdded || slots === 0}
              aria-label={`添加规格 ${option.name} ${option.specification}`} onClick={() => add([option])}>{alreadyAdded ? '已添加' : '添加'}</button>
          </div>;
        })}
      </div>
      {actionError && <div className={styles.pickerActionError} role='alert'>{actionError}</div>}
      <div className={styles.pickerFooter}>
        <button type='button' className={styles.pickerBulk} disabled={!ready || !pending.length} onClick={() => add(pending)}>{query.trim() ? '一键添加搜索结果' : '一键添加全部'}</button>
        <button type='button' className={styles.pickerDone} onClick={onClose}>完成</button>
      </div>
    </div>
  </div>;
}
