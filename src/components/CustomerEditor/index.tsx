import { useEffect, useRef, useState } from 'react';
import { Button, Input, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addCustomer, addSupplier, getCartonInboundCustomers, getCustomer, getCustomers, getSupplier, getSuppliers, updateCustomer, updateCustomerSpecs, updateSupplier } from '@/services/api';
import type { Customer, CustomerForm, CustomerSpec } from '@/types';
import { session, watchSession } from '@/services/session';
import { sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import { formatMoney } from '@/utils/format';
import { getCustomerDimensions } from '@/services/customer-dimensions';
import { canonicalSpecification } from '../../../backend/production-pricing';
import styles from './index.module.scss';

const editorSessionIdentity = () => {
  const current = session();
  return current ? JSON.stringify([current.token, current.user.id, current.user.role, !!current.user.disabled]) : '';
};
type Props = { id?: number; supplier?: boolean; initialName?: string; lockName?: boolean; onClose: () => void; onSaved: (party: Customer) => void | Promise<void> };
export default function CustomerEditor({ id, supplier = false, initialName = '', lockName = false, onClose, onSaved }: Props) {
  const label = supplier ? '供应商' : '客户';
  const [profile, setProfile] = useState({ name: initialName, contact: '', phone: '', address: '', remark: '' });
  const [balance, setBalance] = useState('0');
  const [specRows, setSpecRows] = useState<SpecDraft[]>([]);
  const [specsChanged, setSpecsChanged] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [recoverableError, setRecoverableError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [identity, setIdentity] = useState(editorSessionIdentity);
  const [linkedName, setLinkedName] = useState(lockName);
  const lock = useRef(false);
  const mounted = useRef(true);
  const identityRef = useRef(identity);
  const generation = useRef(0);
  const loadedIdentity = useRef('');
  const invalidatedDraft = useRef(false);
  const initialFocusDone = useRef(false);
  const onCloseRef = useRef(onClose);
  const savingRef = useRef(saving);
  const preservedAccountSpecs = useRef<CustomerSpec[]>([]);
  const deletedDimensionSpecs = useRef<string[]>([]);
  const dimensionRevision = useRef(0);
  const originalAccountSpecsSignature = useRef(serverSpecSignature());
  const originalSpecsSignature = useRef(serverSpecSignature());
  const originalSpecs = useRef<CustomerSpec[]>([]);
  const originalProfileSignature = useRef(serverProfileSignature());
  const writable = !!session() && session()?.user.role !== 'viewer';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; loadedIdentity.current = ''; }; }, []);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = document.querySelector<HTMLElement>('[data-testid="customer-editor"]');
    const focusable = () => Array.from(drawer?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      .filter(item => item.getClientRects().length > 0);
    drawer?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !drawer?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !drawer?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    drawer?.addEventListener('keydown', onKeyDown, true);
    return () => {
      drawer?.removeEventListener('keydown', onKeyDown, true);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);
  useEffect(() => {
    if (loading || loadError || initialFocusDone.current || typeof document === 'undefined') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const drawer = document.querySelector<HTMLElement>('[data-testid="customer-editor"]');
      const firstField = drawer?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled])');
      (firstField || drawer?.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
      initialFocusDone.current = true;
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loading, loadError]);
  useEffect(() => watchSession(() => {
    const next = editorSessionIdentity();
    if (identityRef.current === next) return;
    // Invalidate synchronously, before React re-renders or any awaited read resumes.
    identityRef.current = next;
    generation.current += 1;
    loadedIdentity.current = '';
    if (!id) invalidatedDraft.current = true;
    setProfile({ name: '', contact: '', phone: '', address: '', remark: '' });
    setSpecRows([]); setSpecsChanged(false);
    preservedAccountSpecs.current = []; deletedDimensionSpecs.current = []; dimensionRevision.current = 0;
    originalAccountSpecsSignature.current = serverSpecSignature();
    originalSpecsSignature.current = serverSpecSignature();
    originalSpecs.current = [];
    originalProfileSignature.current = serverProfileSignature();
    setBalance('0'); setLinkedName(false); setError(''); setRecoverableError(false);
    setLoadError(id ? '' : '账号已变化，请关闭资料抽屉后重新打开');
    setLoading(!!id); setIdentity(next);
  }), [id]);
  useEffect(() => {
    let active = true;
    const loadGeneration = ++generation.current;
    const loadIdentity = identity;
    const isCurrent = () => active && mounted.current && generation.current === loadGeneration && identityRef.current === loadIdentity && editorSessionIdentity() === loadIdentity;
    loadedIdentity.current = '';
    setError(''); setLoadError('');
    if (!id) {
      setLoading(false);
      setSpecRows([]); setSpecsChanged(false);
      preservedAccountSpecs.current = []; deletedDimensionSpecs.current = []; dimensionRevision.current = 0;
      originalAccountSpecsSignature.current = serverSpecSignature();
      originalSpecsSignature.current = serverSpecSignature();
      originalSpecs.current = [];
      originalProfileSignature.current = serverProfileSignature();
      if (invalidatedDraft.current) setLoadError('账号已变化，请关闭资料抽屉后重新打开');
      else if (loadIdentity && isCurrent()) loadedIdentity.current = loadIdentity;
      else setLoadError('正在连接共享仓库，请稍候重试');
      return () => { active = false; };
    }
    setLoading(true);
    if (!loadIdentity || !isCurrent()) {
      setLoadError('正在连接共享仓库，请稍候重试'); setLoading(false);
      return () => { active = false; };
    }
    Promise.all([
      supplier ? getSupplier(id) : getCustomer(id),
      supplier ? Promise.resolve(null) : getCustomerDimensions(),
      supplier ? Promise.resolve(null) : getCartonInboundCustomers()
    ]).then(([party, dimensions, inboundCustomers]) => {
      if (!isCurrent()) return;
      if (!party || party.id !== id || typeof party.name !== 'string') throw new Error('资料格式异常，请重新读取');
      if (!supplier && !Array.isArray(dimensions?.customers)) throw new Error('规格关联读取失败，请重新读取');
      if (!supplier && !Array.isArray(inboundCustomers)) throw new Error('客户规格读取失败，请重新读取');
      setLinkedName(!!dimensions?.customers.some(customer => customer.name.trim() === party.name.trim()));
      const loadedProfile = { name: party.name, contact: party.contact || '', phone: party.phone || '', address: party.address || '', remark: party.remark || '' };
      originalProfileSignature.current = serverProfileSignature(loadedProfile);
      setProfile(loadedProfile);
      if (!supplier) {
        const merged = Array.isArray(inboundCustomers) ? inboundCustomers.find(customer => customer.id === party.id) : undefined;
        const accountSpecs = Array.isArray(party.specs) ? party.specs : [];
        const editableSpecs = merged?.specs ?? accountSpecs;
        const accountIds = new Set(accountSpecs.map(spec => stringValue(spec?.id).trim()).filter(Boolean));
        const visibleIds = new Set(editableSpecs.map(spec => stringValue(spec?.id).trim()));
        preservedAccountSpecs.current = accountSpecs.filter(spec => !visibleIds.has(stringValue(spec?.id).trim()));
        deletedDimensionSpecs.current = [];
        dimensionRevision.current = Number(dimensions?.revision) || 0;
        originalAccountSpecsSignature.current = serverSpecSignature(accountSpecs);
        originalSpecsSignature.current = serverSpecSignature(editableSpecs);
        originalSpecs.current = editableSpecs.map(spec => ({ ...spec }));
        setSpecRows(specDrafts(editableSpecs, accountIds));
        setSpecsChanged(false);
      } else {
        preservedAccountSpecs.current = []; deletedDimensionSpecs.current = []; dimensionRevision.current = 0;
        originalAccountSpecsSignature.current = serverSpecSignature();
        originalSpecsSignature.current = serverSpecSignature();
        originalSpecs.current = [];
        setSpecRows([]); setSpecsChanged(false);
      }
      setBalance(String(supplier ? party.payable || 0 : party.debt || 0));
      loadedIdentity.current = loadIdentity;
    }).catch(reason => { if (isCurrent()) setLoadError(reason instanceof Error ? reason.message : '资料读取失败，请重试'); }).finally(() => { if (isCurrent()) setLoading(false); });
    return () => { active = false; };
  }, [id, supplier, retry, identity]);
  const save = async () => {
    if (lock.current || loading || loadError) return;
    const saveIdentity = editorSessionIdentity();
    const saveGeneration = generation.current;
    const isCurrent = () => mounted.current && generation.current === saveGeneration && identityRef.current === saveIdentity && editorSessionIdentity() === saveIdentity && loadedIdentity.current === saveIdentity;
    if (!saveIdentity || !isCurrent()) { setError('账号或资料已变化，请重新读取后保存'); setRecoverableError(true); return; }
    if (session()?.user.role === 'viewer' || session()?.user.disabled) { setError('当前账号没有编辑权限'); return; }
    const data: CustomerForm = Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value.trim()])) as unknown as CustomerForm;
    if (!data.name) { setError('请输入' + label + '名称'); return; }
    if (data.name.length > 50) { setError('名称超过50字，现有规格名称已保留；请先核对并缩短名称后再建立客户账户'); return; }
    if (data.phone && !/^[\d\-+\s()]{6,20}$/.test(data.phone)) { setError('电话格式不正确'); return; }
    if (!id && (!/^\d+(\.\d{1,2})?$/.test(balance) || !Number.isFinite(Number(balance)) || !Number.isSafeInteger(Math.round(Number(balance) * 100)))) { setError('金额须为非负数，最多两位小数'); return; }
    if (!supplier && (!id || specsChanged)) {
      try { validateSpecDrafts(specRows); }
      catch (reason) { setError(reason instanceof Error ? reason.message : '客户规格无效'); return; }
    }
    lock.current = true; setSaving(true); setError(''); setRecoverableError(false);
    try {
      const [parties, dimensions, inboundCustomers] = await Promise.all([
        supplier ? getSuppliers() : getCustomers(),
        supplier ? Promise.resolve(null) : getCustomerDimensions(),
        supplier || !id || !specsChanged ? Promise.resolve(null) : getCartonInboundCustomers()
      ]);
      if (!isCurrent()) return;
      if (!Array.isArray(parties)) throw new Error('名称核对失败，请重试');
      if (!supplier && !Array.isArray(dimensions?.customers)) throw new Error('规格名称核对失败，请重试');
      if (parties.some(party => !party.deleted_at && party.id !== id && party.name.trim() === data.name)) throw new Error('已有同名' + label + '，请打开已有资料编辑');
      if (!id && !initialName && dimensions?.customers.some(customer => customer.name.trim() === data.name)) throw new Error('已有同名客户规格，请从对应客户卡片补充资料');
      if (!supplier && specsChanged && id) {
        const freshCustomer = parties.find(party => party.id === id);
        const fresh = Array.isArray(inboundCustomers) ? inboundCustomers.find(customer => customer.id === id) : null;
        if (!isCurrent()) return;
        if (!freshCustomer || !fresh || fresh.id !== id) throw new EditorRecoveryError('客户资料读取失败，请重新读取后保存');
        if (serverProfileSignature(freshCustomer) !== originalProfileSignature.current) {
          throw new EditorRecoveryError('客户资料已在其他设备更新，请重新读取后再编辑规格');
        }
        if (serverSpecSignature(Array.isArray(freshCustomer.specs) ? freshCustomer.specs : []) !== originalAccountSpecsSignature.current) {
          throw new EditorRecoveryError('客户账户规格已在其他设备更新，请重新读取后再编辑规格');
        }
        if (serverSpecSignature(Array.isArray(fresh.specs) ? fresh.specs : []) !== originalSpecsSignature.current) {
          throw new EditorRecoveryError('客户规格已在其他设备更新，请重新读取后再编辑规格');
        }
        if (Number(dimensions?.revision) !== dimensionRevision.current) {
          throw new EditorRecoveryError('尺寸库已在其他设备更新，请重新读取后再编辑规格');
        }
      }
      let nextSpecs: CustomerSpec[] | null = null;
      if (!supplier && (!id || specsChanged)) {
        const editableAccountSpecs = specRows.filter(row => row.source === 'account');
        nextSpecs = id ? [...preservedAccountSpecs.current, ...toCustomerSpecs(editableAccountSpecs)] : toCustomerSpecs(editableAccountSpecs);
        Object.assign(data, { specs: nextSpecs });
      }
      // Existing balances/specs are deliberately omitted: a profile edit must not
      // overwrite settlements or custom specifications written by another device.
      if (!id) Object.assign(data, supplier ? { payable: Number(balance) } : { debt: Number(balance) });
      if (!isCurrent()) return;
      let party: Customer;
      if (id && !supplier && specsChanged && nextSpecs) {
        const { name, contact, phone, address, remark } = data;
        party = await updateCustomerSpecs(id, {
          profile: { name, contact, phone, address, remark }, specs: nextSpecs, expected_specs: originalSpecs.current,
          dimension_revision: dimensionRevision.current, removed_dimension_spec_ids: deletedDimensionSpecs.current
        });
      } else {
        party = id ? await (supplier ? updateSupplier(id, data) : updateCustomer(id, data)) : await (supplier ? addSupplier(data) : addCustomer(data));
      }
      if (!isCurrent()) return;
      void Taro.showToast({ title: '保存成功', icon: 'success' });
      await onSaved(party);
    } catch (reason) {
      if (isCurrent()) {
        setError(reason instanceof Error ? reason.message : '保存失败，请重试');
        setRecoverableError(reason instanceof EditorRecoveryError);
      }
    }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  };
  const updateSpec = (index: number, key: keyof Omit<SpecDraft, 'id'>, value: string) => {
    setSpecRows(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
    setSpecsChanged(true);
    setError('');
    setRecoverableError(false);
  };
  const addSpec = () => {
    if (specRows.length >= MAX_CUSTOMER_SPECS) { setError('客户规格最多500条'); return; }
    setSpecsChanged(true);
    setSpecRows(rows => [...rows, { id: createSpecId(), goods: '', specification: '', material: '', unit: '个', price: '', source: 'account' }]);
    setError('');
    setRecoverableError(false);
  };
  const removeSpec = (index: number) => {
    const removed = specRows[index];
    if (removed?.source === 'dimension' && !deletedDimensionSpecs.current.includes(removed.id)) {
      deletedDimensionSpecs.current = [...deletedDimensionSpecs.current, removed.id];
    }
    setSpecRows(rows => rows.filter((_, rowIndex) => rowIndex !== index));
    setSpecsChanged(true);
    setError('');
    setRecoverableError(false);
  };
  const field = (key: keyof typeof profile, caption: string, limit: number) => <View className={styles.field}><Text>{caption}</Text><Input aria-label={caption} value={profile[key]} maxlength={limit} disabled={saving || !writable || (key === 'name' && (lockName || linkedName)) || undefined} onInput={event => setProfile(value => ({ ...value, [key]: event.detail.value }))} /></View>;
  const specField = (row: SpecDraft, index: number, key: keyof Omit<SpecDraft, 'id'>, caption: string, limit: number) => <View className={styles.specField}>
    <Text>{caption}</Text>
    <Input aria-label={`规格 ${index + 1} ${caption}`} type={key === 'price' ? 'digit' : undefined} value={row[key]} maxlength={limit} disabled={saving || !writable || row.source === 'dimension' || undefined} onInput={event => updateSpec(index, key, key === 'price' ? sanitizeNonNegativeMoneyInput(event.detail.value) : event.detail.value)} />
  </View>;
  return <View className={styles.mask} onClick={() => { if (!saving) onClose(); }}><View role='dialog' aria-modal='true' aria-label={(id ? '编辑' : '新增') + label} data-testid='customer-editor' className={styles.drawer} onClick={event => event.stopPropagation()}>
    <View className={styles.heading}><Text>{id ? '编辑' : '新增'}{label}资料</Text><Button aria-label='关闭资料抽屉' disabled={saving} onClick={onClose}>×</Button></View>
    {loading && <Text className={styles.hint}>正在读取{label}资料…</Text>}
    {loadError && <View className={styles.error} role='alert'><Text>{loadError}</Text><Button onClick={() => { setError(''); setRecoverableError(false); setRetry(value => value + 1); }}>重新读取</Button></View>}
    {!loading && !loadError && <View>
      {field('name', supplier ? '供应商名称' : '公司名称', 50)}
      {(lockName || linkedName) && <Text className={styles.hint}>此名称关联现有规格，资料编辑保留关联名称。</Text>}
      {!id && lockName && initialName.trim().length > 50 && <View className={styles.error} role='alert'>现有规格名称超过50字，原资料不会被截断；请先核对名称后再建立客户账户。</View>}
      {field('contact', '联系人', 50)}{field('phone', '联系电话', 20)}{field('address', '地址', 200)}
      <View className={styles.field}><Text>备注</Text><Textarea aria-label='备注' value={profile.remark} maxlength={500} disabled={saving || !writable || undefined} onInput={event => setProfile(value => ({ ...value, remark: event.detail.value }))} /></View>
      {!supplier && <View className={styles.specSection}>
        <View className={styles.specHeading}><Text>规格</Text><Button aria-label='添加客户规格' disabled={saving || !writable || specRows.length >= MAX_CUSTOMER_SPECS} onClick={addSpec}>添加规格</Button></View>
        {specRows.map((row, index) => <View className={styles.specRow} data-testid={`customer-spec-editor-${index + 1}`} key={row.id}>
          <View className={styles.specRowHeading}><Text>规格 {index + 1}</Text><Button aria-label={`删除客户规格 ${index + 1}`} disabled={saving || !writable} onClick={() => removeSpec(index)}>删除</Button></View>
          <View className={styles.specFields}>
            {specField(row, index, 'goods', '货物名称', 100)}
            {specField(row, index, 'specification', '规格尺寸', 100)}
            {specField(row, index, 'material', '材质', 100)}
            {specField(row, index, 'unit', '单位', 20)}
            {specField(row, index, 'price', '单价', 30)}
          </View>
          {row.source === 'dimension' && <Text className={styles.hint}>来自旧尺寸库，可在纸箱入库中直接选用；新增同规格客户规格可覆盖报价。</Text>}
        </View>)}
      </View>}
      {id ? <Text className={styles.hint}>{supplier ? '当前应付' : '当前应收'}：{formatMoney(Number(balance))}，请通过结算登记变动。</Text> : <View className={styles.field}><Text>{supplier ? '期初应付（元）' : '期初欠款（元）'}</Text><Input aria-label={supplier ? '期初应付' : '期初欠款'} type='digit' value={balance} disabled={saving || !writable || undefined} onInput={event => setBalance(sanitizeNonNegativeMoneyInput(event.detail.value))} /></View>}
    </View>}
    {!writable && <Text className={styles.hint}>当前账号仅可查看资料</Text>}
    {error && <View className={styles.error} role='alert'><Text>{error}</Text>{recoverableError && <Button disabled={saving} onClick={() => { setError(''); setRecoverableError(false); setRetry(value => value + 1); }}>重新读取</Button>}</View>}
    <View className={styles.actions}><Button disabled={saving} onClick={onClose}>取消</Button><Button className={styles.primary} disabled={loading || !!loadError || saving || !writable} onClick={() => void save()}>{saving ? '保存中…' : '保存' + label}</Button></View>
  </View></View>;
}
type SpecDraft = { id: string; goods: string; specification: string; material: string; unit: string; price: string; source: 'account' | 'dimension' };
class EditorRecoveryError extends Error {}
const MAX_CUSTOMER_SPECS = 500;
const createSpecId = () => `customer-spec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const stringValue = (value: unknown) => value == null ? '' : String(value);
const specDrafts = (specs: CustomerSpec[] = [], accountIds = new Set<string>()): SpecDraft[] => {
  const ids = new Set<string>();
  return specs.map(spec => {
    let id = stringValue(spec?.id).trim();
    while (!id || ids.has(id)) id = createSpecId();
    ids.add(id);
    return {
      id, goods: stringValue(spec?.goods), specification: stringValue(spec?.specification),
      material: stringValue(spec?.material), unit: stringValue(spec?.unit), price: stringValue(spec?.price),
      source: accountIds.has(id) ? 'account' : 'dimension'
    };
  });
};
const serverSpecSignature = (specs: CustomerSpec[] = []) => JSON.stringify(specs.map(spec => ({
  id: spec?.id, goods: spec?.goods, specification: spec?.specification, material: spec?.material, unit: spec?.unit, price: spec?.price
})));
const serverProfileSignature = (profile: Partial<Pick<Customer, 'name' | 'contact' | 'phone' | 'address' | 'remark'>> = {}) => JSON.stringify({
  name: stringValue(profile.name), contact: stringValue(profile.contact), phone: stringValue(profile.phone),
  address: stringValue(profile.address), remark: stringValue(profile.remark)
});
const validateSpecDrafts = (rows: SpecDraft[]) => rows.forEach((row, index) => {
  if (!row.goods.trim()) throw new Error('请填写规格 ' + (index + 1) + ' 的货物名称');
  if (!canonicalSpecification(row.specification.trim(), 'cm')) throw new Error('请填写规格 ' + (index + 1) + ' 的三维尺寸，例如 30×20×15 cm');
  const priceText = row.price.trim();
  if (priceText && (!Number.isFinite(Number(priceText)) || Number(priceText) < 0)) throw new Error('规格 ' + (index + 1) + ' 的单价无效');
});
const toCustomerSpecs = (rows: SpecDraft[]): CustomerSpec[] => rows.map(row => {
  const priceText = row.price.trim();
  return {
    id: row.id, goods: row.goods.trim(), specification: canonicalSpecification(row.specification.trim(), 'cm') || row.specification.trim(),
    material: row.material.trim(), unit: row.unit.trim() || '个',
    price: priceText ? Number(priceText) : null
  } as CustomerSpec;
});
