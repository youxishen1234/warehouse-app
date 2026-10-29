/* eslint-disable react/forbid-elements */
import type { LedgerEntry } from '@/types';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney, formatTime } from '@/utils/format';
import { inferredPartyType } from './model';
import './statement.scss';

export type StatementData = {
  name: string;
  type: 'customer' | 'supplier';
  from: string;
  to: string;
  balance: number;
  entries: LedgerEntry[];
};

export default function Statement({ data, onClose }: { data: StatementData; onClose: () => void }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-statement-print', '');
    return () => document.documentElement.removeAttribute('data-statement-print');
  }, []);
  const billed = data.entries.reduce((sum, row) => sum + (row.type === (data.type === 'customer' ? 'receivable' : 'payable') ? Math.round(row.amount * 100) : 0), 0) / 100;
  const settled = data.entries.reduce((sum, row) => sum + (row.type === 'settlement' ? Math.round(row.amount * 100) : 0), 0) / 100;
  const label = (row: LedgerEntry) => row.type === 'settlement' ? inferredPartyType(row) === 'supplier' ? '付款' : '收款' : row.type === 'receivable' ? '应收' : row.type === 'payable' ? '应付' : row.type === 'income' ? '收入' : '支出';
  return createPortal(<div className='business-statement-overlay' role='dialog' aria-modal='true' aria-label='对账单预览'>
    <div className='business-statement-toolbar'><button type='button' onClick={onClose}>返回账单</button><button type='button' onClick={() => window.print()}>打印对账单</button></div>
    <article className='business-statement-sheet'>
      <h1>{data.type === 'customer' ? '客户' : '供货商'}对账单</h1>
      <p>往来单位：{data.name}</p><p>账期：{data.from || '起始'} 至 {data.to || '现在'}</p>
      <table><thead><tr><th>日期 / 时间</th><th>业务</th><th>单据 / 备注</th><th>金额（元）</th></tr></thead>
        <tbody>{data.entries.map(row => <tr key={row.id}><td>{formatTime(row.created_at)}</td><td>{label(row)}</td><td>{row.remark || `流水 #${row.id}`}</td><td>{formatMoney(row.amount)}</td></tr>)}
          {!data.entries.length && <tr><td colSpan={4}>该账期暂无往来流水</td></tr>}</tbody></table>
      <p>本期{data.type === 'customer' ? '应收' : '应付'}发生额：{formatMoney(billed)}　 本期{data.type === 'customer' ? '收款' : '付款'}：{formatMoney(settled)}</p>
      <p>当前实时未结余额：{formatMoney(data.balance)}（截至打印时，非账期末余额）</p>
      <footer><span>制单日期：{new Date().toLocaleDateString('zh-CN')}</span><span>往来单位确认：________________</span></footer>
    </article>
  </div>, document.body);
}
