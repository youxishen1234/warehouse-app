import React, { useMemo, useState } from 'react';
import { Input, ScrollView, Text, View } from '@tarojs/components';
import styles from './index.module.scss';

type DimensionMode = 'inner' | 'outer';
type DimensionKey = 'length' | 'width' | 'height';

const labels: Record<DimensionKey, string> = { length: '长', width: '宽', height: '高' };
const thicknessOptions = [1.5, 3, 4, 5, 6];

function parseDimension(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function format(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export default function CartonCalculator() {
  const [mode, setMode] = useState<DimensionMode>('inner');
  const [dimensions, setDimensions] = useState<Record<DimensionKey, string>>({ length: '', width: '', height: '' });
  const [thickness, setThickness] = useState('3');

  const values = useMemo(() => ({
    length: parseDimension(dimensions.length),
    width: parseDimension(dimensions.width),
    height: parseDimension(dimensions.height),
    thickness: parseDimension(thickness)
  }), [dimensions, thickness]);

  const complete = values.length !== null && values.width !== null && values.height !== null && values.thickness !== null;
  const targetMode: DimensionMode = mode === 'inner' ? 'outer' : 'inner';
  const target = complete ? {
    length: mode === 'inner' ? values.length! + values.thickness! * 2 : values.length! - values.thickness! * 2,
    width: mode === 'inner' ? values.width! + values.thickness! * 2 : values.width! - values.thickness! * 2,
    height: mode === 'inner' ? values.height! + values.thickness! * 2 : values.height! - values.thickness! * 2
  } : null;
  const invalidOuter = target && (target.length <= 0 || target.width <= 0 || target.height <= 0);

  const changeMode = (next: DimensionMode) => {
    if (next === mode) return;
    setMode(next);
  };

  return <ScrollView scrollY className={styles.page}>
    <View className={styles.heading}>
      <Text>纸箱尺寸换算</Text>
      <Text>按瓦楞厚度换算内尺寸与外尺寸</Text>
    </View>

    <View className={styles.card}>
      <Text className={styles.label}>已知尺寸类型</Text>
      <View className={styles.segmented}>
        <View className={`${styles.segment} ${mode === 'inner' ? styles.active : ''}`} onClick={() => changeMode('inner')}>内尺寸</View>
        <View className={`${styles.segment} ${mode === 'outer' ? styles.active : ''}`} onClick={() => changeMode('outer')}>外尺寸</View>
      </View>

      <View className={styles.fields}>
        {(Object.keys(labels) as DimensionKey[]).map(key => <View className={styles.field} key={key}>
          <Text>{mode === 'inner' ? `内${labels[key]}` : `外${labels[key]}`}<Text>mm</Text></Text>
          <Input type="digit" inputMode="decimal" value={dimensions[key]} placeholder="请输入" onInput={event => setDimensions(current => ({ ...current, [key]: event.detail.value }))} />
        </View>)}
      </View>
    </View>

    <View className={styles.card}>
      <Text className={styles.label}>瓦楞厚度</Text>
      <View className={styles.thicknessRow}>
        {thicknessOptions.map(item => <View key={item} className={`${styles.chip} ${thickness === String(item) ? styles.chipActive : ''}`} onClick={() => setThickness(String(item))}>{item} mm</View>)}
      </View>
      <View className={styles.customThickness}>
        <Text>自定义厚度</Text>
        <Input type="digit" inputMode="decimal" value={thickness} onInput={event => setThickness(event.detail.value)} />
        <Text>mm</Text>
      </View>
    </View>

    <View className={styles.resultCard}>
      <View className={styles.resultHeader}>
        <Text>{targetMode === 'inner' ? '内尺寸结果' : '外尺寸结果'}</Text>
        <Text>{mode === 'inner' ? '内尺寸 + 双面厚度' : '外尺寸 - 双面厚度'}</Text>
      </View>
      {!complete && <Text className={styles.placeholder}>填写长、宽、高和瓦楞厚度后显示结果</Text>}
      {complete && invalidOuter && <Text className={styles.error}>外尺寸必须大于两倍瓦楞厚度</Text>}
      {target && !invalidOuter && <View className={styles.resultGrid}>
        {(Object.keys(labels) as DimensionKey[]).map(key => <View key={key}>
          <Text>{targetMode === 'inner' ? `内${labels[key]}` : `外${labels[key]}`}</Text>
          <Text>{format(target[key])}<Text> mm</Text></Text>
        </View>)}
      </View>}
    </View>
  </ScrollView>;
}
