/* eslint-disable react/forbid-elements */
import { useId, useMemo, useState } from 'react';
import './style.scss';

export type QuickSpecOption = { id: string; title: string; detail?: string; search?: string };
const normalized = (value: string) => value.toLocaleLowerCase().replace(/[\s×x*]/g, '');

export default function QuickSpecPicker({ label, options, selected, disabled = false, onSelect, onCreate }: {
  label: string; options: QuickSpecOption[]; selected?: string; disabled?: boolean;
  onSelect: (id: string) => void; onCreate: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(12);
  const matches = useMemo(() => {
    const needle = normalized(query);
    return options.filter(option => !needle || normalized([option.title, option.detail, option.search].filter(Boolean).join(' ')).includes(needle));
  }, [options, query]);
  return <section className='quick-spec-picker' aria-label={label} data-no-tab-swipe>
    <span className='quick-spec-label'>{label}</span>
    <button type='button' className='quick-spec-trigger' disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{selected || '点击选择常用规格'}</span><span aria-hidden='true'>{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <div id={id} className='quick-spec-panel'>
      <input type='search' aria-label={`搜索${label}`} value={query} disabled={disabled} placeholder='名称、尺寸、客户或供货商' onChange={event => { setQuery(event.target.value); setLimit(12); }} />
      <div className='quick-spec-options'>
        {matches.slice(0, limit).map(option => <button type='button' key={option.id} disabled={disabled} onClick={() => { onSelect(option.id); setOpen(false); setQuery(''); }}>
          <strong>{option.title}</strong>{option.detail && <small>{option.detail}</small>}
        </button>)}
      </div>
      {!matches.length && <p>{options.length ? '没有找到匹配的规格' : '暂无常用规格'}</p>}
      {matches.length > limit && <button type='button' className='quick-spec-more' onClick={() => setLimit(value => value + 12)}>再显示 12 项</button>}
      <button type='button' className='quick-spec-more' disabled={disabled} onClick={() => { setOpen(false); onCreate(); }}>＋ 新增规格</button>
    </div>}
    {!open && <button type='button' className='quick-spec-new' disabled={disabled} onClick={onCreate}>＋ 新增规格</button>}
  </section>;
}
