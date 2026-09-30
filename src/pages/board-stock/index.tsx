import { useCallback, useMemo, useState } from 'react';
import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { BoardPage, BoardButton, BoardField, BoardEmpty, BoardError } from '../../components/BoardUI';
import { BoardBatch, getBoards, boardSpec, cartonSpec, today } from '../../services/boards';
import { useSharedRefresh } from '../../services/shared-refresh';
import { BoardGlyph, BoardMaterial } from '../../components/BoardUI/visuals';
export default function BoardStock() {
  const [batches, setBatches] = useState<BoardBatch[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [expanded, setExpanded] = useState('');
  const load = useCallback(async () => { try { setBatches(await getBoards()); setError(''); } catch (e) { setError(e.message); } finally { setLoading(false); } }, []);
  useDidShow(load); useSharedRefresh(load);
  const groups = useMemo(() => {
    const map = new Map<string, { batch: BoardBatch; batches: BoardBatch[]; quantity: number; warning: number }>();
    batches.forEach(b => { const g = map.get(b.specKey) || { batch: b, batches: [], quantity: 0, warning: 0 }; g.batches.push(b); g.quantity += b.remainingQty; g.warning = Math.max(g.warning, b.warningQty); map.set(b.specKey, g); });
    return [...map.values()].sort((a, b) => Number(b.quantity > 0 && b.quantity <= b.warning) - Number(a.quantity > 0 && a.quantity <= a.warning));
  }, [batches]);
  const total = batches.reduce((n, b) => n + b.remainingQty, 0);
  const warnings = groups.filter(g => g.quantity <= g.warning && g.warning > 0).length;
  const monthIn = batches.filter(b => b.date.startsWith(today().slice(0, 7))).reduce((n, b) => n + b.receivedQty, 0);
  const shown = groups.filter(g => {
    const haystack = [boardSpec(g.batch), cartonSpec(g.batch), g.batch.fluteType, ...g.batches.map(b => b.supplier + ' ' + b.location + ' ' + b.id)].join(' ').toLowerCase().replace(/[ ×x*]/g, '');
    return haystack.includes(query.toLowerCase().replace(/[ ×x*]/g, '')) && (filter === 'all' || (filter === 'warning' ? g.warning > 0 && g.quantity <= g.warning : g.quantity === 0));
  });
  const go = (page: string, id = '') => Taro.navigateTo({ url: '/pages/' + page + '/index' + (id ? '?id=' + encodeURIComponent(id) : '') });
  return <BoardPage back={false} title='纸板库存' subtitle='来料、领用、余量，一眼掌握。' action={<BoardButton secondary onClick={load}>刷新</BoardButton>}>
    <View className='board-summary inventory-hero' aria-label='库存总览'><View className='inventory-hero-main'><View><Text className='inventory-live'><i /> 实时库存</Text><Text className='board-summary-number'>{loading || error ? '—' : total.toLocaleString()}<small>张</small></Text><Text className='board-muted'>{batches.filter(b => b.remainingQty > 0).length} 批来料在库</Text></View><BoardMaterial /></View><View className='board-summary-bottom'><View><strong>{loading || error ? '—' : groups.length}</strong><Text className='board-muted'>纸板规格</Text></View><View className={warnings ? 'inventory-warning' : ''}><strong>{loading || error ? '—' : warnings}</strong><Text className='board-muted'>待补货</Text></View><View><strong>{loading || error ? '—' : monthIn.toLocaleString()}</strong><Text className='board-muted'>本月来料 / 张</Text></View></View></View>
    <View className='board-actions inventory-shortcuts'><Button className='inventory-shortcut primary' onClick={() => go('board-receive')}><View className='shortcut-icon'><BoardGlyph kind='plus' /></View><View><strong>来料入库</strong><Text>记一笔新来料</Text></View><BoardGlyph kind='arrow' /></Button><Button className='inventory-shortcut' onClick={() => go('board-scan')}><View className='shortcut-icon'><BoardGlyph kind='scan' /></View><View><strong>扫码找纸板</strong><Text>找到眼前这批</Text></View></Button></View>
    <View className='board-search'><BoardField label='查找纸板' value={query} onChange={setQuery} placeholder='纸板 / 纸箱尺寸、板厂或库位' /></View>
    <View className='board-tabs'>{[['all', '全部规格'], ['warning', '待补货 ' + warnings], ['empty', '已用完']].map(([key, label]) => <Button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</Button>)}</View>
    {error && <BoardError message={error} retry={load} />}
    {loading && <BoardEmpty title='正在读取仓库' hint='获取最新库存和批次记录…' />}
    {!loading && !error && !batches.length && <BoardEmpty title='从第一批纸板开始' hint='按板厂送货单记一笔，自动生成批次标签。领料后库存实时扣减。'><BoardButton onClick={() => go('board-receive')}>录入第一批来料</BoardButton></BoardEmpty>}
    {!loading && !error && batches.length > 0 && !shown.length && <BoardEmpty title='没有符合条件的纸板' hint='试试其他尺寸、板厂名称，或切换筛选。' />}
    {!error && <View className='board-stock-list'>{shown.map(g => <View className='board-card inventory-card' key={g.batch.specKey}>
      <View className='inventory-card-heading'><View className='inventory-material-badge'><BoardGlyph kind='layers' /><Text>{g.batch.layers}层 · {g.batch.fluteType}楞</Text></View><Text className={'board-tag ' + (g.warning > 0 && g.quantity <= g.warning ? 'warn' : '')}>{g.quantity === 0 ? '已用完' : g.warning > 0 && g.quantity <= g.warning ? '待补货' : '库存正常'}</Text></View>
      <View className='inventory-specs'><View><Text className='inventory-caption'>纸板规格</Text><Text className='board-spec'>{boardSpec(g.batch)}<small>cm</small></Text></View><View className='inventory-carton'><Text className='inventory-caption'>对应纸箱 · cm</Text><Text>{cartonSpec(g.batch)}</Text></View></View>
      <Text className='inventory-supplier'>{[...new Set(g.batches.map(b => b.supplier))].join(' / ')}<Text> · {g.batches.length} 个批次</Text></Text>
      <View className='board-card-footer'><View><Text className='board-qty'>{g.quantity.toLocaleString()}</Text><Text className='board-qty-unit'>张可用</Text></View><Button onClick={() => setExpanded(expanded === g.batch.specKey ? '' : g.batch.specKey)}>{expanded === g.batch.specKey ? '收起批次' : '查看批次 ›'}</Button></View>
      {expanded === g.batch.specKey && <View>{g.batches.slice().sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt).map(b => <View key={b.id} className='board-timeline'><View className='board-row'><strong>{b.supplier}</strong><Text>{b.remainingQty} 张</Text></View><Text className='board-muted'>{b.date} 入库 · {b.location || '未填写库位'}</Text><Text className='board-batch-id'>{b.id}</Text><View className='board-actions'><BoardButton secondary onClick={() => go('board-detail', b.id)}>详情 / 标签</BoardButton><BoardButton disabled={b.remainingQty === 0} onClick={() => go('board-outbound', b.id)}>领料</BoardButton></View></View>)}<BoardButton secondary onClick={() => Taro.navigateTo({ url: '/pages/board-receive/index?from=' + g.batch.id })}>按此规格再进一批</BoardButton></View>}
    </View>)}</View>}
  </BoardPage>;
}
