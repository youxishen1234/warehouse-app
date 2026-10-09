import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Input, Textarea, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getCustomer, addCustomer, updateCustomer, getSupplier, addSupplier, updateSupplier } from '@/services/api';
import type { CustomerForm } from '@/types';
import { sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import { session, watchSession } from '@/services/session';
import styles from './index.module.scss';

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
        else void Taro.redirectTo({ url: supplier ? '/pages/suppliers/index' : '/pages/customers/index' });
      }, 800);
    } catch (e) { saveLock.current = false; Taro.showToast({ title: e?.message || '保存失败', icon: 'none' }); } finally { setSaving(false); }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <Text className={styles.label}>{isEdit ? '编辑' : '新增'}{label}</Text>
      {loading && <View>正在加载{label}资料…</View>}
      {loadError && <View onClick={() => setRetry(value => value + 1)}>{loadError} · 点击重试</View>}
      {!loading && !loadError &&
      <View className={styles.form}>
        <View className={styles.field}>
          <Text className={styles.label}>{label}名称 *</Text>
          <Input className={styles.input} maxlength={50} placeholder="如：晨光文具店" value={name} onInput={e => setName(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>联系人</Text>
          <Input className={styles.input} maxlength={50} placeholder="如：李老板" value={contact} onInput={e => setContact(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>联系电话</Text>
          <Input className={styles.input} type="number" maxlength={20} placeholder="客户手机号" value={phone} onInput={e => setPhone(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>地址</Text>
          <Input className={styles.input} maxlength={200} placeholder="选填" value={address} onInput={e => setAddress(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>备注</Text>
          <Textarea className={styles.textarea} maxlength={500} placeholder="选填，如结算方式、偏好等" value={remark} onInput={e => setRemark(e.detail.value)} />
        </View>

        <View className={styles.field}><Text className={styles.label}>{supplier ? '应付款（元）' : '当前欠款（元）'}</Text><Input className={styles.input} type="digit" value={balance} onInput={e => setBalance(sanitizeNonNegativeMoneyInput(e.detail.value))} /></View>
        <View className={styles.btnPrimary} onClick={handleSave}>{saving ? '保存中' : '保存'}</View>
      </View>}
    </ScrollView>
  );
};

export default CustomerEditPage;
