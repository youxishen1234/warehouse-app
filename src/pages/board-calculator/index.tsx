import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { BoardPage, BoardButton, BoardField } from '../../components/BoardUI';
import PhotoMeasure from '../../components/PhotoMeasure';
export default function BoardCalculator() {
  const [form, setForm] = useState({ length: '', width: '', height: '', quantity: '1' });
  const [tool, setTool] = useState('calculate');
  const [mode, setMode] = useState('inner');
  const change = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }));
  const l = Number(form.length), w = Number(form.width), h = Number(form.height), q = Number(form.quantity);
  const valid = [form.length, form.width, form.height, form.quantity].every(v => v.trim() !== '') && [l, w, h].every(v => Number.isFinite(v) && v > 0 && v <= 100000) && Number.isSafeInteger(q) && q > 0 && q <= 100000000;
  const length = (l + w) * 2 + (mode === 'inner' ? 6 : 4);
  const width = w + h + (mode === 'inner' ? 2 : 1);
  const area = length * width / 10000;
  const fmt = (n: number) => String(Number(n.toFixed(4)));
  const summary = '五层 AB 楞 · ' + (mode === 'inner' ? '内径' : '外径') + '\n纸箱：' + l + ' × ' + w + ' × ' + h + ' cm\n纸板：' + fmt(length / 100) + ' × ' + fmt(width / 100) + ' 米\n单张面积：' + fmt(area) + ' m²\n数量：' + q + ' 张\n总面积：' + fmt(area * q) + ' m²';
  return <BoardPage title='纸箱计算器' subtitle='五层 AB 楞 · 尺寸计算与拍照测压线'>
    <View className='board-actions'><BoardButton secondary={tool !== 'calculate'} onClick={() => setTool('calculate')}>尺寸计算</BoardButton><BoardButton secondary={tool !== 'measure'} onClick={() => setTool('measure')}>拍照测压线</BoardButton></View>
    <View style={{ display: tool === 'measure' ? 'block' : 'none' }}><PhotoMeasure /></View>
    <View style={{ display: tool === 'calculate' ? 'block' : 'none' }}>
    <View className='board-section'><Text className='board-section-title'>客户纸箱尺寸 · cm</Text><View className='board-grid three'>{[['length', '纸箱长'], ['width', '纸箱宽'], ['height', '纸箱高']].map(([key, label]) => <BoardField key={key} label={label} numeric value={form[key]} onChange={v => change(key, v)} unit='cm' />)}</View><View className='board-actions'><BoardButton secondary={mode !== 'inner'} onClick={() => setMode('inner')}>内径</BoardButton><BoardButton secondary={mode !== 'outer'} onClick={() => setMode('outer')}>外径</BoardButton></View><Text className='board-note'>{mode === 'inner' ? '纸板长 =（长 + 宽）× 2 + 6 cm；纸板宽 = 宽 + 高 + 2 cm' : '纸板长 =（长 + 宽）× 2 + 4 cm；纸板宽 = 宽 + 高 + 1 cm'}</Text></View>
    <View className='board-section'><BoardField label='生产数量' numeric value={form.quantity} onChange={v => change('quantity', v)} unit='张' /></View>
    {valid ? <View className='board-section'><Text className='board-section-title'>报给板厂的纸板尺寸</Text><Text className='board-spec' style={{ display: 'block' }}>{fmt(length / 100)} × {fmt(width / 100)} 米</Text><View className='board-detail-row'><Text>单张面积</Text><strong>{fmt(area)} m²</strong></View><View className='board-detail-row'><Text>总面积</Text><strong>{fmt(area * q)} m²</strong></View><Text className='board-note'>输入尺寸已按所选内径 / 外径直接套用公式，不另加厚度。</Text><BoardButton onClick={() => Taro.setClipboardData({ data: summary })}>复制计算结果</BoardButton></View> : <View className='board-section'><Text className='board-muted'>填写完整的正数尺寸和正整数数量后显示结果。</Text></View>}
    </View>
  </BoardPage>;
}
