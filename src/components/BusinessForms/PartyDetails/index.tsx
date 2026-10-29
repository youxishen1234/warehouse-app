/* eslint-disable react/forbid-elements */
import React, { useState, useEffect, useRef } from 'react';
import { DemoSheet, DemoField } from '@/components/DemoUI';
import Taro, { useRouter } from '@tarojs/taro';
import { getCustomer, addCustomer, updateCustomer, getSupplier, addSupplier, updateSupplier } from '@/services/api';
import type { CustomerForm } from '@/types';
import { sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import { session, watchSession } from '@/services/session';

const CustomerEditPage: React.FC = () => {
  const router = useRouter();
  const supplier = router.params.party === 'supplier';
  const label = supplier ? '供应商' : '客户';
  const [balance, setBalance] = useState('0');
  const [saving, setSaving] = useState(false);
  const editId = router.params.id ? Number(router.params.id) : null;
  const isEdit = !!editId;
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [sessionToken, setSessionToken] = useState(() => session()?.token);
  const saveLock = useRef(false);
  const backTimer = useRef<ReturnType<typeof setTimeout>>();

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [remark, setRemark] = useState('');

  useEffect(() => watchSession(() => setSessionToken(session()?.token)), []);
  useEffect(() => {
    let active = true;
    if (isEdit && editId) {
      setLoading(true); setLoadError('');
      if (!sessionToken) return () => { active = false; };
      (supplier ? getSupplier(editId) : getCustomer(editId)).then(c => {
        if (!active) return;
        setBalance(String(supplier ? c.payable || 0 : c.debt || 0));
        setName(c.name);
        setContact(c.contact || '');
        setPhone(c.phone || '');
        setAddress(c.address || '');
        setRemark(c.remark || '');
      }).catch(e => { if (active) setLoadError(e instanceof Error ? e.message : '资料加载失败，请重试'); })
        .finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [isEdit, editId, supplier, retry, sessionToken]);
  useEffect(() => () => { if (backTimer.current) clearTimeout(backTimer.current); }, []);

  const handleSave = async () => {
    if (saveLock.current || loading || loadError) return;
    if (!name.trim()) { Taro.showToast({ title: `请输入${label}名称`, icon: 'none' }); return; }
    if (!/^\d+(\.\d{1,2})?$/.test(balance)) { Taro.showToast({ title: '金额须为非负数，最多两位小数', icon: 'none' }); return; }
    if (phone && !/^[\d\-+\s()]{6,20}$/.test(phone.trim())) {
      Taro.showToast({ title: '电话格式不正确', icon: 'none' }); return;
    }
    const data: CustomerForm = {
      name: name.trim(),
      contact: contact.trim(),
      phone: phone.trim(),
      address: address.trim(),
      remark: remark.trim(),
      ...(supplier ? { payable: Number(balance) } : { debt: Number(balance) })
    };
    try {
      saveLock.current = true;
      setSaving(true);
      if (isEdit && editId) {
        await (supplier ? updateSupplier(editId, data) : updateCustomer(editId, data));
      } else {
        await (supplier ? addSupplier(data) : addCustomer(data));
      }
      Taro.showToast({ title: '保存成功', icon: 'success' });
      backTimer.current = setTimeout(() => {
        if (Taro.getCurrentPages().length > 1) void Taro.navigateBack();
        else void Taro.redirectTo({ url: supplier ? '/pages/management/index?section=suppliers' : '/pages/customers/index' });
      }, 800);
    } catch (e) { saveLock.current = false; Taro.showToast({ title: e?.message || '保存失败', icon: 'none' }); } finally { setSaving(false); }
  };

  return <DemoSheet title={(isEdit ? '编辑' : '新增') + label + '资料'} busy={saving}>
    <p>{label}资料保存后，开单、送货和结算时直接复用。</p>
    {loading && <p>正在加载{label}资料…</p>}
    {loadError && <div role='alert' className='demo-error'>{loadError}<button type='button' className='demo-action' onClick={() => setRetry(value => value + 1)}>重新读取</button></div>}
    {!loading && !loadError && <>
      <DemoField label={label + '名称（必填）'}><input aria-label={label + '名称'} maxLength={50} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></DemoField>
      <DemoField label='联系人'><input aria-label='联系人' maxLength={50} value={contact} disabled={saving} onChange={event => setContact(event.target.value)} /></DemoField>
      <DemoField label='手机号码'><input type='tel' aria-label='联系电话' maxLength={20} value={phone} disabled={saving} onChange={event => setPhone(event.target.value)} /></DemoField>
      <DemoField label='送货地址'><input aria-label='地址' maxLength={200} value={address} disabled={saving} onChange={event => setAddress(event.target.value)} /></DemoField>
      <DemoField label='业务备注'><textarea aria-label='备注' maxLength={500} value={remark} disabled={saving} onChange={event => setRemark(event.target.value)} /></DemoField>
      <details className='demo-more'><summary>{supplier ? '应付款' : '应收款'}</summary><DemoField label={supplier ? '应付款（元）' : '当前欠款（元）'}><input type='number' value={balance} disabled={saving} onChange={event => setBalance(sanitizeNonNegativeMoneyInput(event.target.value))} /></DemoField></details>
      <button type='button' className='demo-primary' disabled={saving} onClick={() => void handleSave()}>{saving ? '保存中…' : '保存' + label + '资料'}</button>
    </>}
  </DemoSheet>;
};

export default CustomerEditPage;
