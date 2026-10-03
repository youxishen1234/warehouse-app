/* eslint-disable react/forbid-elements -- The assistant runs in H5/Capacitor; native selects avoid the custom-element disabled attribute bug. */
import type { AiSchema } from '@/services/ai';
import styles from './index.module.scss';

export function normalized(value: any, schema: AiSchema): any {
  if (schema.type === 'object') return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== '').map(([key, item]) => [key, schema.properties?.[key] ? normalized(item, schema.properties[key]) : item]));
  if (schema.type === 'array') return (value || []).map(item => normalized(item, schema.items!));
  if (['number', 'integer'].includes(schema.type)) return typeof value === 'string' ? Number(value) : value;
  return value;
}

export default function DraftForm({ schema, value, onChange, disabled = false, prefix = '' }: { schema: AiSchema; value: any; onChange: (value: any) => void; disabled?: boolean; prefix?: string }) {
  if (schema.type === 'array') {
    const rows = Array.isArray(value) ? value : [];
    return <div className={styles.lineGroup}>
      {rows.map((row, index) => <div key={index} className={styles.lineCard}>
        <div className={styles.row}><span className={styles.label}>{schema.title} {index + 1}</span><button data-ai-control="button" className={styles.textButton} disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}>移除</button></div>
        <DraftForm schema={schema.items!} value={row} prefix={`${schema.title}${index + 1} `} disabled={disabled} onChange={next => onChange(rows.map((old, i) => i === index ? next : old))} />
      </div>)}
      <button data-ai-control="button" className={styles.secondary} disabled={disabled || rows.length >= (schema.maxItems || 20)} onClick={() => onChange([...rows, {}])}>＋ 添加{schema.title}</button>
    </div>;
  }
  if (schema.type !== 'object') return null;
  return <div className={styles.form}>
    {Object.entries(schema.properties || {}).map(([key, field]) => {
      const label = field.title || key;
      const item = value?.[key];
      const change = (next: any) => onChange({ ...(value || {}), [key]: next });
      const required = schema.required?.includes(key);
      if (field.type === 'object' || field.type === 'array') return <div key={key} className={styles.wideField}>
        <span className={styles.label}>{label}{required ? ' *' : '（选填）'}</span>
        <DraftForm schema={field} value={item} onChange={change} disabled={disabled} prefix={prefix + label + ' '} />
      </div>;
      return <div className={styles.field} key={key}>
        <span className={styles.label}>{label}{required ? ' *' : ''}</span>
        {field.type === 'boolean' ? <select data-ai-control="select" aria-label={prefix + label} className={styles.input} disabled={disabled} value={item === undefined ? '' : String(item)} onChange={event => change(event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true')}><option value=''>请选择</option><option value='true'>是</option><option value='false'>否</option></select>
          : field.enum ? <select data-ai-control="select" aria-label={prefix + label} className={styles.input} disabled={disabled} value={item || ''} onChange={event => change(event.currentTarget.value)}><option value=''>请选择</option>{field.enum.map(option => <option key={option} value={option}>{option}</option>)}</select>
          : <input data-ai-control="input" aria-label={prefix + label} className={styles.input} value={item === undefined ? '' : String(item)} disabled={disabled} type='text' inputMode={['integer', 'number'].includes(field.type) ? 'decimal' : 'text'} maxLength={500} placeholder={required ? '请填写' : '选填'} onChange={event => change(event.currentTarget.value)} />}
      </div>;
    })}
  </div>;
}
