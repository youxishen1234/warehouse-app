import React, { useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { COPY_DEFAULTS, getAllCopy, saveCopy } from '@/services/copy';
import styles from './index.module.scss';

const labels: Record<string, string> = { appName:'应用名称', homeTitle:'首页标题', inbound:'入库菜单', outbound:'出库菜单', inventory:'库存菜单', products:'商品菜单', customers:'客户菜单', suppliers:'供应商菜单', records:'记录菜单', ledger:'账本菜单', orders:'订单菜单', addProduct:'新增商品按钮', confirmInbound:'确认入库按钮', confirmOutbound:'确认出库按钮' };
export default function CustomCopyPage() {
  const [values, setValues] = useState(getAllCopy());
  const save = () => { saveCopy(values); Taro.showToast({ title:'文案已保存', icon:'success' }); setTimeout(() => Taro.reLaunch({ url: '/pages/home/index' }), 500); };
  return <ScrollView scrollY className={styles.page}><Text className={styles.header}>自定义文案</Text><Text className={styles.hint}>修改后返回页面即可生效，留空会使用默认文字。</Text><View className={styles.form}>{Object.keys(COPY_DEFAULTS).map(key => <View className={styles.row} key={key}><Text className={styles.label}>{labels[key] || key}</Text><Input className={styles.input} value={values[key]} onInput={e => setValues(prev => ({ ...prev, [key]: e.detail.value }))} /></View>)}</View><View className={styles.save} onClick={save}>保存文案</View></ScrollView>;
}
