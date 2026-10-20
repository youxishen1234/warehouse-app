import { useEffect, useRef, useState } from 'react';
import { Button, Input, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addCustomer, addSupplier, getCustomer, getCustomers, getSupplier, getSuppliers, updateCustomer, updateSupplier } from '@/services/api';
import type { Customer, CustomerForm } from '@/types';
import { session, watchSession } from '@/services/session';
import { sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import { formatMoney } from '@/utils/format';
import { getCustomerDimensions } from '@/services/customer-dimensions';
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
  const [loading, setLoading] = useState(!!id);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
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
  const writable = !!session() && session()?.user.role !== 'viewer';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; loadedIdentity.current = ''; }; }, []);
  useEffect(() => watchSession(() => {
    const next = editorSessionIdentity();
    if (identityRef.current === next) return;
    // Invalidate synchronously, before React re-renders or any awaited read resumes.
    identityRef.current = next;
    generation.current += 1;
    loadedIdentity.current = '';
    if (!id) invalidatedDraft.current = true;
    setProfile({ name: '', contact: '', phone: '', address: '', remark: '' });
    setBalance('0'); setLinkedName(false); setError('');
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
    Promise.all([supplier ? getSupplier(id) : getCustomer(id), supplier ? Promise.resolve(null) : getCustomerDimensions()]).then(([party, dimensions]) => {
      if (!isCurrent()) return;
      if (!party || party.id !== id || typeof party.name !== 'string') throw new Error('资料格式异常，请重新读取');
      if (!supplier && !Array.isArray(dimensions?.customers)) throw new Error('规格关联读取失败，请重新读取');
      setLinkedName(!!dimensions?.customers.some(customer => customer.name.trim() === party.name.trim()));
      setProfile({ name: party.name, contact: party.contact || '', phone: party.phone || '', address: party.address || '', remark: party.remark || '' });
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
    if (!saveIdentity || !isCurrent()) { setError('账号或资料已变化，请重新读取后保存'); return; }
    if (session()?.user.role === 'viewer' || session()?.user.disabled) { setError('当前账号没有编辑权限'); return; }
    const data: CustomerForm = Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, value.trim()])) as unknown as CustomerForm;
    if (!data.name) { setError('请输入' + label + '名称'); return; }
    if (data.name.length > 50) { setError('名称超过50字，现有规格名称已保留；请先核对并缩短名称后再建立客户账户'); return; }
    if (data.phone && !/^[\d\-+\s()]{6,20}$/.test(data.phone)) { setError('电话格式不正确'); return; }
    if (!id && (!/^\d+(\.\d{1,2})?$/.test(balance) || !Number.isFinite(Number(balance)) || !Number.isSafeInteger(Math.round(Number(balance) * 100)))) { setError('金额须为非负数，最多两位小数'); return; }
    lock.current = true; setSaving(true); setError('');
    try {
      const [parties, dimensions] = await Promise.all([supplier ? getSuppliers() : getCustomers(), supplier ? Promise.resolve(null) : getCustomerDimensions()]);
      if (!isCurrent()) return;
      if (!Array.isArray(parties)) throw new Error('名称核对失败，请重试');
      if (!supplier && !Array.isArray(dimensions?.customers)) throw new Error('规格名称核对失败，请重试');
      if (parties.some(party => !party.deleted_at && party.id !== id && party.name.trim() === data.name)) throw new Error('已有同名' + label + '，请打开已有资料编辑');
      if (!id && !initialName && dimensions?.customers.some(customer => customer.name.trim() === data.name)) throw new Error('已有同名客户规格，请从对应客户卡片补充资料');
      // Existing balances/specs are deliberately omitted: a profile edit must not
      // overwrite settlements or custom specifications written by another device.
      if (!id) Object.assign(data, supplier ? { payable: Number(balance) } : { debt: Number(balance) });
      if (!isCurrent()) return;
      const party = id ? await (supplier ? updateSupplier(id, data) : updateCustomer(id, data)) : await (supplier ? addSupplier(data) : addCustomer(data));
      if (!isCurrent()) return;
      void Taro.showToast({ title: '保存成功', icon: 'success' });
      await onSaved(party);
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : '保存失败，请重试'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  };
  const field = (key: keyof typeof profile, caption: string, limit: number) => <View className={styles.field}><Text>{caption}</Text><Input aria-label={caption} value={profile[key]} maxlength={limit} disabled={saving || !writable || (key === 'name' && (lockName || linkedName)) || undefined} onInput={event => setProfile(value => ({ ...value, [key]: event.detail.value }))} /></View>;
  return <View className={styles.mask} onClick={() => { if (!saving) onClose(); }}><View role='dialog' aria-modal='true' aria-label={(id ? '编辑' : '新增') + label} data-testid='customer-editor' className={styles.drawer} onClick={event => event.stopPropagation()}>
    <View className={styles.heading}><Text>{id ? '编辑' : '新增'}{label}资料</Text><Button aria-label='关闭资料抽屉' disabled={saving} onClick={onClose}>×</Button></View>
    {loading && <Text className={styles.hint}>正在读取{label}资料…</Text>}
    {loadError && <View className={styles.error} role='alert'><Text>{loadError}</Text><Button onClick={() => setRetry(value => value + 1)}>重新读取</Button></View>}
    {!loading && !loadError && <View>
      {field('name', supplier ? '供应商名称' : '公司名称', 50)}
      {(lockName || linkedName) && <Text className={styles.hint}>此名称关联现有规格，资料编辑保留关联名称。</Text>}
      {!id && lockName && initialName.trim().length > 50 && <View className={styles.error} role='alert'>现有规格名称超过50字，原资料不会被截断；请先核对名称后再建立客户账户。</View>}
      {field('contact', '联系人', 50)}{field('phone', '联系电话', 20)}{field('address', '地址', 200)}
      <View className={styles.field}><Text>备注</Text><Textarea aria-label='备注' value={profile.remark} maxlength={500} disabled={saving || !writable || undefined} onInput={event => setProfile(value => ({ ...value, remark: event.detail.value }))} /></View>
      {id ? <Text className={styles.hint}>{supplier ? '当前应付' : '当前应收'}：{formatMoney(Number(balance))}，请通过结算登记变动。</Text> : <View className={styles.field}><Text>{supplier ? '期初应付（元）' : '期初欠款（元）'}</Text><Input aria-label={supplier ? '期初应付' : '期初欠款'} type='digit' value={balance} disabled={saving || !writable || undefined} onInput={event => setBalance(sanitizeNonNegativeMoneyInput(event.detail.value))} /></View>}
    </View>}
    {!writable && <Text className={styles.hint}>当前账号仅可查看资料</Text>}
    {error && <View className={styles.error} role='alert'>{error}</View>}
    <View className={styles.actions}><Button disabled={saving} onClick={onClose}>取消</Button><Button className={styles.primary} disabled={loading || !!loadError || saving || !writable} onClick={() => void save()}>{saving ? '保存中…' : '保存' + label}</Button></View>
  </View></View>;
}
