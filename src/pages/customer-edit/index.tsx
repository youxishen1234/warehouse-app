import React, { useState, useEffect } from 'react';
import { View, Text, Input, Textarea, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getCustomer, addCustomer, updateCustomer, getSupplier, addSupplier, updateSupplier } from '@/services/api';
import type { CustomerForm } from '@/types';
import styles from './index.module.scss';

const CustomerEditPage: React.FC = () => {
  const router = useRouter();
  const supplier = router.params.party === 'supplier';
  const label = supplier ? '供应商' : '客户';
  const [balance, setBalance] = useState('0');
  const [saving, setSaving] = useState(false);
  const editId = router.params.id ? Number(router.params.id) : null;
  const isEdit = !!editId;

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [remark, setRemark] = useState('');

  useEffect(() => {
    if (isEdit && editId) {
      (supplier ? getSupplier(editId) : getCustomer(editId)).then(c => {
        setBalance(String(supplier ? c.payable || 0 : c.debt || 0));
        setName(c.name);
        setContact(c.contact || '');
        setPhone(c.phone || '');
        setAddress(c.address || '');
        setRemark(c.remark || '');
      }).catch(e => console.error('[CustomerEdit] load failed', e));
    }
  }, [isEdit, editId]);

  const handleSave = async () => {
    if (saving) return;
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
      setSaving(true);
      if (isEdit && editId) {
        await (supplier ? updateSupplier(editId, data) : updateCustomer(editId, data));
      } else {
        await (supplier ? addSupplier(data) : addCustomer(data));
      }
      Taro.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => Taro.navigateBack(), 800);
    } catch (e) { console.error('[CustomerEdit] save failed', e); Taro.showToast({ title: e?.message || '保存失败', icon: 'none' }); } finally { setSaving(false); }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <View className={styles.form}>
        <View className={styles.field}>
          <Text className={styles.label}>{label}名称 *</Text>
          <Input className={styles.input} placeholder="如：晨光文具店" value={name} onInput={e => setName(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>联系人</Text>
          <Input className={styles.input} placeholder="如：李老板" value={contact} onInput={e => setContact(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>联系电话</Text>
          <Input className={styles.input} type="number" placeholder="客户手机号" value={phone} onInput={e => setPhone(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>地址</Text>
          <Input className={styles.input} placeholder="选填" value={address} onInput={e => setAddress(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>备注</Text>
          <Textarea className={styles.textarea} placeholder="选填，如结算方式、偏好等" value={remark} onInput={e => setRemark(e.detail.value)} />
        </View>

        <View className={styles.field}><Text className={styles.label}>{supplier ? '应付款（元）' : '当前欠款（元）'}</Text><Input className={styles.input} type="digit" value={balance} onInput={e => setBalance(e.detail.value)} /></View>
        <View className={styles.btnPrimary} onClick={handleSave}>{saving ? '保存中' : '保存'}</View>
      </View>
    </ScrollView>
  );
};

export default CustomerEditPage;
