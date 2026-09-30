import React, { useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './index.module.scss';

export default function BoardInbound() {
  const [supplier, setSupplier] = useState('');
  const [supplierIndex, setSupplierIndex] = useState(0);
  const [deliveryDate, setDeliveryDate] = useState('');
  
  // 纸板规格
  const [boardLength, setBoardLength] = useState('');
  const [boardWidth, setBoardWidth] = useState('');
  const [fluteType, setFluteType] = useState('B');
  const [faceGsm, setFaceGsm] = useState('');
  const [linerGsm, setLinerGsm] = useState('');
  const [flutingGsm, setFlutingGsm] = useState('');
  
  // 纸箱规格
  const [cartonLength, setCartonLength] = useState('');
  const [cartonWidth, setCartonWidth] = useState('');
  const [cartonHeight, setCartonHeight] = useState('');
  
  // 数量
  const [orderedQty, setOrderedQty] = useState('');
  const [deliveredQty, setDeliveredQty] = useState('');
  const [billedArea, setBilledArea] = useState('');
  
  const [remark, setRemark] = useState('');
  
  const supplierList = ['XX纸业', 'YY纸板厂', 'ZZ包装', '其他'];
  const fluteTypes = ['A', 'B', 'C', 'E', 'F'];

  const handleSupplierChange = (e) => {
    const index = e.detail.value;
    setSupplierIndex(index);
    setSupplier(supplierList[index]);
  };

  const handleFluteChange = (e) => {
    const index = e.detail.value;
    setFluteType(fluteTypes[index]);
  };

  const handleSave = () => {
    if (!supplier) {
      Taro.showToast({ title: '请选择供应商', icon: 'none' });
      return;
    }
    if (!boardLength || !boardWidth) {
      Taro.showToast({ title: '请填写纸板规格', icon: 'none' });
      return;
    }
    if (!cartonLength || !cartonWidth || !cartonHeight) {
      Taro.showToast({ title: '请填写纸箱规格', icon: 'none' });
      return;
    }
    if (!deliveredQty) {
      Taro.showToast({ title: '请填写送货数量', icon: 'none' });
      return;
    }

    const boardData = {
      supplier,
      deliveryDate,
      boardLength: Number(boardLength),
      boardWidth: Number(boardWidth),
      fluteType,
      faceGsm: Number(faceGsm) || 0,
      linerGsm: Number(linerGsm) || 0,
      flutingGsm: Number(flutingGsm) || 0,
      cartonLength: Number(cartonLength),
      cartonWidth: Number(cartonWidth),
      cartonHeight: Number(cartonHeight),
      orderedQty: Number(orderedQty) || 0,
      deliveredQty: Number(deliveredQty),
      billedArea: Number(billedArea) || 0,
      remark,
      createdAt: new Date().toISOString()
    };

    console.log('纸板入库数据：', boardData);
    
    Taro.showToast({
      title: '入库成功',
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
          <Text className={styles.navbarTitle}>纸板入库</Text>
        </View>
      </View>

      <ScrollView scrollY className={styles.content}>
        {/* 送货单头部卡片 */}
        <View className={styles.headerCard}>
          <Text className={styles.headerLabel}>📦 送货单号</Text>
          <Text className={styles.headerTitle}>自动生成</Text>
          <Text className={styles.headerSubtitle}>入库日期：{new Date().toLocaleDateString('zh-CN')}</Text>
        </View>

        {/* 供应商信息 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>供应商信息</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>供应商</Text>
              <Picker mode="selector" range={supplierList} onChange={handleSupplierChange} value={supplierIndex}>
                <Text className={styles.formValue}>{supplier || '请选择供应商'}</Text>
              </Picker>
            </View>
            <View className={styles.formDivider} />
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>送货日期</Text>
              <Picker mode="date" onChange={(e) => setDeliveryDate(e.detail.value)} value={deliveryDate}>
                <Text className={styles.formValue}>{deliveryDate || '请选择日期'}</Text>
              </Picker>
            </View>
          </View>
        </View>

        {/* 纸板规格 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>纸板规格</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>展开尺寸</Text>
              <View className={styles.sizeInputGroup}>
                <Input
                  className={styles.sizeInput}
                  type="digit"
                  placeholder="长"
                  value={boardLength}
                  onInput={(e) => setBoardLength(e.detail.value)}
                />
                <Text className={styles.sizeX}>×</Text>
                <Input
                  className={styles.sizeInput}
                  type="digit"
                  placeholder="宽"
                  value={boardWidth}
                  onInput={(e) => setBoardWidth(e.detail.value)}
                />
                <Text className={styles.sizeUnit}>cm</Text>
              </View>
            </View>
            
            <View className={styles.formDivider} />
            
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>楞型</Text>
              <Picker mode="selector" range={fluteTypes} onChange={handleFluteChange}>
                <Text className={styles.formValue}>三层{fluteType}楞</Text>
              </Picker>
            </View>
            
            <View className={styles.formDivider} />
            
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>克重配置</Text>
              <View className={styles.gsmInputGroup}>
                <View className={styles.gsmItem}>
                  <Text className={styles.gsmLabel}>面</Text>
                  <Input
                    className={styles.gsmInput}
                    type="number"
                    placeholder="150"
                    value={faceGsm}
                    onInput={(e) => setFaceGsm(e.detail.value)}
                  />
                </View>
                <View className={styles.gsmItem}>
                  <Text className={styles.gsmLabel}>里</Text>
                  <Input
                    className={styles.gsmInput}
                    type="number"
                    placeholder="150"
                    value={linerGsm}
                    onInput={(e) => setLinerGsm(e.detail.value)}
                  />
                </View>
                <View className={styles.gsmItem}>
                  <Text className={styles.gsmLabel}>楞</Text>
                  <Input
                    className={styles.gsmInput}
                    type="number"
                    placeholder="120"
                    value={flutingGsm}
                    onInput={(e) => setFlutingGsm(e.detail.value)}
                  />
                </View>
                <Text className={styles.gsmUnit}>g/m²</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 纸箱规格 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>对应纸箱</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>纸箱尺寸</Text>
              <View className={styles.sizeInputGroup}>
                <Input
                  className={styles.sizeInput}
                  type="digit"
                  placeholder="长"
                  value={cartonLength}
                  onInput={(e) => setCartonLength(e.detail.value)}
                />
                <Text className={styles.sizeX}>×</Text>
                <Input
                  className={styles.sizeInput}
                  type="digit"
                  placeholder="宽"
                  value={cartonWidth}
                  onInput={(e) => setCartonWidth(e.detail.value)}
                />
                <Text className={styles.sizeX}>×</Text>
                <Input
                  className={styles.sizeInput}
                  type="digit"
                  placeholder="高"
                  value={cartonHeight}
                  onInput={(e) => setCartonHeight(e.detail.value)}
                />
                <Text className={styles.sizeUnit}>cm</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 数量信息 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>数量信息</Text>
          <View className={styles.card}>
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>订购数量</Text>
              <View className={styles.qtyInputGroup}>
                <Input
                  className={styles.qtyInput}
                  type="number"
                  placeholder="0"
                  value={orderedQty}
                  onInput={(e) => setOrderedQty(e.detail.value)}
                />
                <Text className={styles.qtyUnit}>张</Text>
              </View>
            </View>
            
            <View className={styles.formDivider} />
            
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>送货数量</Text>
              <View className={styles.qtyInputGroup}>
                <Input
                  className={styles.qtyInput}
                  type="number"
                  placeholder="0"
                  value={deliveredQty}
                  onInput={(e) => setDeliveredQty(e.detail.value)}
                />
                <Text className={styles.qtyUnit}>张</Text>
                {orderedQty && deliveredQty && Number(deliveredQty) > Number(orderedQty) && (
                  <Text className={styles.giftTag}>+{Number(deliveredQty) - Number(orderedQty)}赠</Text>
                )}
              </View>
            </View>
            
            <View className={styles.formDivider} />
            
            <View className={styles.formRow}>
              <Text className={styles.formLabel}>计费平米</Text>
              <View className={styles.qtyInputGroup}>
                <Input
                  className={styles.qtyInput}
                  type="digit"
                  placeholder="0"
                  value={billedArea}
                  onInput={(e) => setBilledArea(e.detail.value)}
                />
                <Text className={styles.qtyUnit}>m²</Text>
              </View>
            </View>

            <View className={styles.totalDivider} />

            <View className={styles.totalRow}>
              <Text className={styles.totalLabel}>入库总数</Text>
              <Text className={styles.totalValue}>{deliveredQty || 0} 张</Text>
            </View>
          </View>
        </View>

        {/* 备注 */}
        <View className={styles.section}>
          <Text className={styles.sectionTitle}>备注</Text>
          <View className={styles.card}>
            <Input
              className={styles.remarkInput}
              placeholder="选填，如：纸板质量、配送情况等"
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
        <View className={styles.saveBtn} onClick={handleSave}>确认入库</View>
      </View>
    </View>
  );
}
