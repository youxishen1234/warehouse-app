import { useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './index.module.scss';

export default function BoardOutbound() {
  const [boardSpec, setBoardSpec] = useState('');
  const [boardIndex, setBoardIndex] = useState(0);
  const [outboundQty, setOutboundQty] = useState('');
  const [recipient, setRecipient] = useState('');
  const [purpose, setPurpose] = useState('');
  const [remark, setRemark] = useState('');

  // 模拟纸板规格列表
  const boardSpecs = [
    '165×115cm → 40×30×20 (XX纸业)',
    '140×100cm → 35×25×18 (YY纸板厂)',
  ];

  const handleBoardChange = (e) => {
    const index = e.detail.value;
    setBoardIndex(index);
    setBoardSpec(boardSpecs[index]);
  };

  const handleSave = () => {
    if (!boardSpec) {
      Taro.showToast({ title: '请选择纸板规格', icon: 'none' });
      return;
    }
    if (!outboundQty) {
      Taro.showToast({ title: '请填写领料数量', icon: 'none' });
      return;
    }
    if (!recipient) {
      Taro.showToast({ title: '请填写领料人', icon: 'none' });
      return;
    }

    const outboundData = {
      boardSpec,
      outboundQty: Number(outboundQty),
      recipient,
      purpose,
      remark,
      createdAt: new Date().toISOString()
    };

    console.log('纸板领料数据：', outboundData);
    
    Taro.showToast({
      title: '领料成功',
      icon: 'success',
      duration: 2000
    });
    
    setTimeout(() => {
      Taro.navigateBack();
    }, 2000);
  };

  const handleCancel = () => {
    Taro.navigateBack();
  };

  return (
    <View className={styles.page}>
      <View className={styles.navbar}>
        <View className={styles.navbarContent}>
          <Text className={styles.navbarTitle}>纸板领料</Text>
        </View>
      </View>

      <ScrollView scrollY className={styles.content}>
        {/* 领料单头部卡片 */}
        <View className={styles.headerCard}>
          <Text className={styles.headerLabel}>📋 领料单号</Text>
          <Text className={styles.headerTitle}>自动生成</Text>
          <Text className={styles.headerSubtitle}>领料日期：{new Date().toLocaleDateString('zh-CN')}</Text>
        </View>

        {/* 纸板规格选择 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>纸板规格</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>选择规格</Text>
              <Picker mode="selector" range={boardSpecs} onChange={handleBoardChange} value={boardIndex}>
                <Text className={styles.formValue}>{boardSpec || '请选择纸板规格'}</Text>
              </Picker>
            </View>
          </View>
        </View>

        {/* 领料数量 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>领料数量</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>领料数量</Text>
              <View className={styles.qtyInputGroup}>
                <Input
                  className={styles.qtyInput}
                  type="number"
                  placeholder="0"
                  value={outboundQty}
                  onInput={(e) => setOutboundQty(e.detail.value)}
                />
                <Text className={styles.qtyUnit}>张</Text>
              </View>
            </View>

            <View className={styles.totalDivider} />

            <View className={styles.totalRow}>
              <Text className={styles.totalLabel}>本次领料</Text>
              <Text className={styles.totalValue}>{outboundQty || 0} 张</Text>
            </View>
          </View>
        </View>

        {/* 领料信息 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>领料信息</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>领料人</Text>
              <Input
                className={styles.formInput}
                placeholder="请输入领料人姓名"
                value={recipient}
                onInput={(e) => setRecipient(e.detail.value)}
              />
            </View>
            
            <View className={styles.formDivider} />
            
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>用途</Text>
              <Input
                className={styles.formInput}
                placeholder="请输入用途（选填）"
                value={purpose}
                onInput={(e) => setPurpose(e.detail.value)}
              />
            </View>
          </View>
        </View>

        {/* 备注 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>备注</Text>
          <View className={styles.card}>
            <Input
              className={styles.remarkInput}
              placeholder="选填"
              value={remark}
              onInput={(e) => setRemark(e.detail.value)}
            />
          </View>
        </View>

        <View className={styles.bottomSpace} />
      </ScrollView>

      {/* 底部操作栏 */}
      <View className={styles.footer}>
        <View className={styles.cancelBtn} onClick={handleCancel}>取消</View>
        <View className={styles.saveBtn} onClick={handleSave}>确认领料</View>
      </View>
    </View>
  );
}
