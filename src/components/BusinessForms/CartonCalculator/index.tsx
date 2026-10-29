/* eslint-disable react/forbid-elements */
import { useMemo, useState } from 'react';
import { DemoPage, DemoField, DemoDetail } from '@/components/DemoUI';
import { sanitizeDimensionInput } from '@/components/BusinessForms/CartonCalculator/math';
import { calculateTargetDimension, formatDimension, parseDimension, type DimensionMode } from '@/components/BusinessForms/CartonCalculator/math';

type DimensionKey = 'length' | 'width' | 'height';

const labels: Record<DimensionKey, string> = { length: '长', width: '宽', height: '高' };
const thicknessOptions = [1.5, 3, 4, 5, 6];

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
    length: calculateTargetDimension(values.length!, values.thickness!, mode),
    width: calculateTargetDimension(values.width!, values.thickness!, mode),
    height: calculateTargetDimension(values.height!, values.thickness!, mode)
  } : null;
  const invalidOuter = target && (target.length <= 0 || target.width <= 0 || target.height <= 0);

  const changeMode = (next: DimensionMode) => {
    if (next === mode) return;
    setMode(next);
  };

  return <DemoPage title='纸箱尺寸换算'>
    <div className='demo-pills'>{(['inner', 'outer'] as const).map(value => <button type='button' key={value} aria-pressed={mode === value} onClick={() => changeMode(value)}>{value === 'inner' ? '内尺寸' : '外尺寸'}</button>)}</div>
    <article className='demo-card'><h3>纸箱尺寸（mm）</h3>{(Object.keys(labels) as DimensionKey[]).map(key => <DemoField key={key} label={labels[key]}><input type='number' aria-label={labels[key]} value={dimensions[key]} onChange={event => setDimensions(current => ({ ...current, [key]: sanitizeDimensionInput(event.target.value) }))} /></DemoField>)}</article>
    <article className='demo-card'><h3>瓦楞厚度</h3><div className='demo-pills'>{thicknessOptions.map(value => <button type='button' key={value} aria-pressed={thickness === String(value)} onClick={() => setThickness(String(value))}>{value} mm</button>)}</div><DemoField label='自定义厚度（mm）'><input type='number' aria-label='自定义厚度' value={thickness} onChange={event => setThickness(sanitizeDimensionInput(event.target.value))} /></DemoField></article>
    <article className='demo-card'><h3>{targetMode === 'inner' ? '内尺寸结果' : '外尺寸结果'}</h3>{!complete && <p>填写长、宽、高和瓦楞厚度后显示结果</p>}{complete && invalidOuter && <div className='demo-error'>外尺寸必须大于两倍瓦楞厚度</div>}{target && !invalidOuter && (Object.keys(labels) as DimensionKey[]).map(key => <DemoDetail key={key} label={labels[key]}>{formatDimension(target[key])} mm</DemoDetail>)}</article>
  </DemoPage>;
}
