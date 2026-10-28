import { ReactNode } from 'react';
import { View, Text, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import { getCopy } from '@/services/copy';
import './style.scss';
import './web.scss';
export function BoardPage({ title, subtitle, children, back = true, action, eyebrow, tone = 'default', steps, activeStep = 0 }: { title: string; subtitle?: string; children: ReactNode; back?: boolean; action?: ReactNode; eyebrow?: string; tone?: 'default' | 'inbound' | 'outbound'; steps?: [string, string, string]; activeStep?: number }) {
  const appName = getCopy('appName');
  return <View className={'board-page board-page--' + tone} data-ui-version='web-workbench-v2'><View className='board-header'><View className='board-heading'>{back && <Button className='board-back' onClick={() => { if (Taro.getCurrentPages().length > 1) Taro.navigateBack(); else Taro.switchTab({ url: '/pages/inventory/index' }); }} aria-label='返回'>‹</Button>}<View><Text className='board-eyebrow'>{appName} · {eyebrow || '纸板仓库'}</Text><Text className='board-title'>{title}</Text></View></View>{action}</View>{subtitle && <Text className='board-subtitle'>{subtitle}</Text>}{steps && <View className='board-steps' aria-label='办理步骤'>{steps.map((step, index) => <View className={'board-step' + (index === activeStep ? ' is-active' : '')} key={step}><Text className='board-step-number'>{index + 1}</Text><Text>{step}</Text></View>)}</View>}<View className='board-content'>{children}</View></View>;
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
