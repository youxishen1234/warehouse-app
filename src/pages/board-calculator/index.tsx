import { useState, useMemo } from 'react';
import { View, Text, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';

import styles from './index.module.scss';

type FluteType = 'A' | 'B' | 'C' | 'E';
type DimensionType = 'inner' | 'outer';

const fluteData: Record<FluteType, { thickness: number; ratio: number }> = {
  A: { thickness: 5, ratio: 1.55 },
  B: { thickness: 3, ratio: 1.36 },
  C: { thickness: 4, ratio: 1.45 },
  E: { thickness: 1.5, ratio: 1.25 }
};

export default function BoardCalculator() {
  const [length, setLength] = useState('40');
  const [width, setWidth] = useState('30');
  const [height, setHeight] = useState('20');
  const [dimensionType, setDimensionType] = useState<DimensionType>('inner');
  const [fluteType, setFluteType] = useState<FluteType>('A');
  
  // 纸张克重
  const [faceGsm, setFaceGsm] = useState('130'); // 面纸
  const [backGsm, setBackGsm] = useState('130'); // 里纸
  const [fluteGsm, setFluteGsm] = useState('110'); // 楞纸

  const thickness = fluteData[fluteType].thickness;

  const result = useMemo(() => {
    const l = parseFloat(length);
    const w = parseFloat(width);
    const h = parseFloat(height);

    if (isNaN(l) || isNaN(w) || isNaN(h) || l <= 0 || w <= 0 || h <= 0) {
      return null;
    }

    // 统一成外径
    const outerLength = dimensionType === 'inner' ? l + thickness / 10 : l;
    const outerWidth = dimensionType === 'inner' ? w + thickness / 10 : w;
    const outerHeight = dimensionType === 'inner' ? h + thickness / 10 : h;

    // 纸板尺寸（加0.5cm压线头）
    const boardLength = (outerLength + outerWidth) * 2 + 0.5;
    const boardWidth = outerHeight + outerLength + 0.5;

    // 每平方米克重计算
    const face = parseFloat(faceGsm) || 0;
    const back = parseFloat(backGsm) || 0;
    const flute = parseFloat(fluteGsm) || 0;
    const ratio = fluteData[fluteType].ratio;
    const totalGsm = face + back + flute * ratio;

    // 纸板面积（平方米）
    const boardArea = (boardLength * boardWidth) / 10000;

    // 单张重量（公斤）
    const weightPerSheet = (boardArea * totalGsm) / 1000;

    return {
      outer: { length: outerLength, width: outerWidth, height: outerHeight },
      board: { length: boardLength, width: boardWidth },
      totalGsm: totalGsm,
      boardArea: boardArea,
      weightPerSheet: weightPerSheet
    };
  }, [length, width, height, dimensionType, thickness, fluteType, faceGsm, backGsm, fluteGsm]);

  const copyResult = () => {
    if (!result) return;
    const text = `纸箱外径：${result.outer.length.toFixed(1)}×${result.outer.width.toFixed(1)}×${result.outer.height.toFixed(1)} cm
纸板尺寸：${result.board.length.toFixed(1)} × ${result.board.width.toFixed(1)} cm
材质：三层${fluteType}楞
面纸：${faceGsm}g 里纸：${backGsm}g 楞纸：${fluteGsm}g
总克重：${result.totalGsm.toFixed(1)} g/m²
单张重量：${result.weightPerSheet.toFixed(3)} kg`;
    Taro.setClipboardData({ data: text }).then(() => {
      Taro.showToast({ title: '已复制到剪贴板', icon: 'success' });
    });
  };

  return (
    <View className={styles.page}>
      
      <View className={styles.content}>
        <View className={styles.card}>
          <Text className={styles.sectionTitle}>客户尺寸（厘米）</Text>
          <View className={styles.dimensionInputs}>
            <View className={styles.inputGroup}>
              <Text className={styles.label}>长</Text>
              <Input
                className={styles.input}
                type="digit"
                value={length}
                placeholder="长度"
                onInput={e => setLength(e.detail.value)}
              />
            </View>
            <View className={styles.inputGroup}>
              <Text className={styles.label}>宽</Text>
              <Input
                className={styles.input}
                type="digit"
                value={width}
                placeholder="宽度"
                onInput={e => setWidth(e.detail.value)}
              />
            </View>
            <View className={styles.inputGroup}>
              <Text className={styles.label}>高</Text>
              <Input
                className={styles.input}
                type="digit"
                value={height}
                placeholder="高度"
                onInput={e => setHeight(e.detail.value)}
              />
            </View>
          </View>
        </View>

        <View className={styles.card}>
          <Text className={styles.sectionTitle}>客户给的是</Text>
          <View className={styles.radioGroup}>
            <View
              className={`${styles.radioOption} ${dimensionType === 'inner' ? styles.selected : ''}`}
              onClick={() => setDimensionType('inner')}
            >
              <View className={styles.radio}>{dimensionType === 'inner' && <View className={styles.radioDot} />}</View>
              <Text>内径（装货空间）</Text>
            </View>
            <View
              className={`${styles.radioOption} ${dimensionType === 'outer' ? styles.selected : ''}`}
              onClick={() => setDimensionType('outer')}
            >
              <View className={styles.radio}>{dimensionType === 'outer' && <View className={styles.radioDot} />}</View>
              <Text>外径（纸箱外部尺寸）</Text>
            </View>
          </View>
        </View>

        <View className={styles.card}>
          <Text className={styles.sectionTitle}>纸板楞型</Text>
          <View className={styles.fluteGroup}>
            {(['A', 'B', 'C', 'E'] as const).map(type => (
              <View
                key={type}
                className={`${styles.fluteOption} ${fluteType === type ? styles.selected : ''}`}
                onClick={() => setFluteType(type)}
              >
                <Text>{type}楞 ({fluteData[type].thickness}mm)</Text>
              </View>
            ))}
          </View>
        </View>

        <View className={styles.card}>
          <Text className={styles.sectionTitle}>纸张克重（g/m²）</Text>
          <View className={styles.gsmInputs}>
            <View className={styles.inputGroup}>
              <Text className={styles.label}>面纸</Text>
              <Input
                className={styles.input}
                type="number"
                value={faceGsm}
                placeholder="面纸克重"
                onInput={e => setFaceGsm(e.detail.value)}
              />
            </View>
            <View className={styles.inputGroup}>
              <Text className={styles.label}>里纸</Text>
              <Input
                className={styles.input}
                type="number"
                value={backGsm}
                placeholder="里纸克重"
                onInput={e => setBackGsm(e.detail.value)}
              />
            </View>
            <View className={styles.inputGroup}>
              <Text className={styles.label}>楞纸</Text>
              <Input
                className={styles.input}
                type="number"
                value={fluteGsm}
                placeholder="楞纸克重"
                onInput={e => setFluteGsm(e.detail.value)}
              />
            </View>
          </View>
        </View>

        {result && (
          <View className={styles.result}>
            <Text className={styles.resultTitle}>计算结果</Text>
            <Text className={styles.resultItem}>纸箱外径：{result.outer.length.toFixed(1)}×{result.outer.width.toFixed(1)}×{result.outer.height.toFixed(1)} cm</Text>
            <View className={styles.divider} />
            <Text className={styles.resultLabel}>━━ 报给板厂的尺寸 ━━</Text>
            <Text className={styles.resultItem}>纸板长：{result.board.length.toFixed(1)} cm</Text>
            <Text className={styles.resultFormula}>({result.outer.length.toFixed(1)}+{result.outer.width.toFixed(1)})×2+0.5</Text>
            <Text className={styles.resultItem}>纸板宽：{result.board.width.toFixed(1)} cm</Text>
            <Text className={styles.resultFormula}>{result.outer.height.toFixed(1)}+{result.outer.length.toFixed(1)}+0.5</Text>
            <View className={styles.divider} />
            <Text className={styles.resultItem}>材质：三层{fluteType}楞</Text>
            <Text className={styles.resultMeta}>面纸 {faceGsm}g · 里纸 {backGsm}g · 楞纸 {fluteGsm}g</Text>
            <Text className={styles.resultItem}>总克重：{result.totalGsm.toFixed(1)} g/m²</Text>
            <Text className={styles.resultItem}>纸板面积：{result.boardArea.toFixed(3)} m²/张</Text>
            <Text className={styles.resultItem}>单张重量：{result.weightPerSheet.toFixed(3)} kg</Text>
            <Button className={styles.copyBtn} onClick={copyResult}>复制文字</Button>
          </View>
        )}
      </View>
    </View>
  );
}
