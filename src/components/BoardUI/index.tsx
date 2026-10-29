/* eslint-disable react/forbid-elements */
import { ReactNode } from 'react';
import { View, Text, Input, Button } from '@tarojs/components';
import Icon from '../Icon';
import { DemoPage } from '@/components/DemoUI';
import './style.scss';
export function BoardPage({ title, subtitle, children, action }: { title: string; subtitle?: string; children: ReactNode; back?: boolean; action?: ReactNode; eyebrow?: string; tone?: 'default' | 'inbound' | 'outbound'; steps?: [string, string, string]; activeStep?: number }) {
  return <DemoPage title={title} subtitle={subtitle} action={action}><div className='board-demo-content'>{children}</div></DemoPage>;
}
export function BoardButton({ children, onClick, secondary = false, disabled = false }: { children: ReactNode; onClick: () => void; secondary?: boolean; disabled?: boolean }) { return <Button disabled={disabled || undefined} className={'board-button ' + (secondary ? 'is-secondary ' : '') + (disabled ? 'is-disabled' : '')} onClick={() => { if (!disabled) onClick(); }}>{children}</Button>; }
export function BoardConfirmBar({ label, amount, action, confirmLabel, busyLabel, busy = false, disabled = false, onConfirm }: { label: string; amount: string; action: string; confirmLabel: string; busyLabel: string; busy?: boolean; disabled?: boolean; onConfirm: () => void }) {
  return <View className='board-confirm-rail'><View className='board-confirm-bar' aria-label={action}>
    <View className='board-confirm-summary'><Text className='board-confirm-label'>{label}</Text><Text className='board-confirm-amount'>{amount}</Text></View>
    <View role='button' aria-disabled={disabled || busy || undefined} className={'board-confirm-action ' + (disabled || busy ? 'is-disabled ' : '') + (busy ? 'btnDisabled' : '')} onClick={() => { if (!disabled && !busy) onConfirm(); }}>{busy ? busyLabel : confirmLabel}</View>
  </View></View>;
}
export function BoardField({ label, value, onChange, placeholder = '', numeric = false, unit, optional = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; numeric?: boolean; unit?: string; optional?: boolean }) { return <View className='board-field'><Text className='board-field-label'>{label}{optional && <Text className='board-muted'> · 选填</Text>}</Text><View className='board-input-wrap'><Input aria-label={label} type={numeric ? 'digit' : 'text'} value={value} onInput={e => onChange(e.detail.value)} placeholder={placeholder} maxlength={label.includes('备注') || label.includes('原因') ? 500 : 120} />{unit && <Text className='board-muted'>{unit}</Text>}</View></View>; }
export function BoardEmpty({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) { return <View className='board-empty'><View className='board-empty-icon'><Icon name='box' style={{ width: 30, height: 30 }} color='#647a70' /></View><Text className='board-section-title'>{title}</Text><Text className='board-muted'>{hint}</Text>{children}</View>; }
export function BoardError({ message, retry }: { message: string; retry?: () => void }) { return <View className='board-error' role='alert'><Text>{message}</Text>{retry && <Button onClick={retry}>重新加载</Button>}</View>; }
