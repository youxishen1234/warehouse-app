import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './index.module.scss';

export type PartyCategory = '纸箱' | '纸板' | '其他';

export type PartyGood = {
  id: string | number;
  goods?: string;
  specification?: string;
  material?: string;
  unit?: string;
  price?: number | null;
  unitPrice?: number | null;
  category?: PartyCategory;
  kind?: '成品' | '纸板';
  boardLength?: number | null;
  boardWidth?: number | null;
  cartonLength?: number | null;
  cartonWidth?: number | null;
  cartonHeight?: number | null;
  fluteType?: string;
  layers?: number | null;
};

export type PartySearchItem = {
  id: number;
  name: string;
  contact?: string;
  phone?: string;
  address?: string;
  remark?: string;
  specs?: PartyGood[];
  deleted_at?: number | null;
  updated_at?: number;
  created_at?: number;
};

export type PartyType = 'customer' | 'supplier';

type PartySearchPanelProps = {
  partyType: PartyType;
  parties: PartySearchItem[];
  recentIds?: number[];
  selectedId?: number | null;
  disabled?: boolean;
  onSelect: (party: PartySearchItem | null) => void;
};

const recentKey = (type: PartyType) => `party-search-recent-${type}`;
const readRecent = (type: PartyType) => {
  try {
    const value = Taro.getStorageSync(recentKey(type));
    return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) as number[] : [];
  } catch { return []; }
};
const usageKey = (type: PartyType) => `party-search-usage-${type}`;
const readUsage = (type: PartyType): Record<number, number> => {
  try {
    const value = Taro.getStorageSync(usageKey(type));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};
const searchText = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, '');

/** Bottom-sheet picker shared by management and inbound forms. */
export function PartySearchPanel({ partyType, parties, recentIds, selectedId, disabled = false, onSelect }: PartySearchPanelProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [storedRecent, setStoredRecent] = useState(() => readRecent(partyType));
  const [usage, setUsage] = useState(() => readUsage(partyType));
  const title = partyType === 'customer' ? '客户' : '供货商';
  const recentOrder = recentIds || storedRecent;
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const sheet = document.querySelector<HTMLElement>(`[data-party-search-sheet="${partyType}"]`);
    const focusable = () => Array.from(sheet?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
      .filter(element => element.getClientRects().length > 0);
    sheet?.querySelector<HTMLInputElement>('input')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
      if (event.key !== 'Tab') return;
      const fields = focusable();
      if (!fields.length) { event.preventDefault(); return; }
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sheet?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sheet?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = oldOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, partyType]);
  const visible = useMemo(() => {
    const needle = searchText(query);
    return parties.filter(party => !party.deleted_at && (!needle || searchText([
      party.name, party.contact, party.phone, ...(party.specs || []).map(item => item.goods)
    ].join(' ')).includes(needle))).sort((left, right) => {
      const leftRecent = recentOrder.indexOf(left.id), rightRecent = recentOrder.indexOf(right.id);
      if (leftRecent !== rightRecent) return (leftRecent === -1 ? Number.MAX_SAFE_INTEGER : leftRecent)
        - (rightRecent === -1 ? Number.MAX_SAFE_INTEGER : rightRecent);
      return Number(right.id === selectedId) - Number(left.id === selectedId)
        || (Number(usage[right.id]) || 0) - (Number(usage[left.id]) || 0)
        || (right.updated_at || right.created_at || 0) - (left.updated_at || left.created_at || 0);
    });
  }, [parties, query, recentOrder, selectedId, usage]);
  const choose = (party: PartySearchItem | null) => {
    if (disabled) return;
    if (party) {
      const next = [party.id, ...readRecent(partyType).filter(id => id !== party.id)].slice(0, 12);
      const nextUsage = { ...readUsage(partyType) };
      nextUsage[party.id] = (Number(nextUsage[party.id]) || 0) + 1;
      try { Taro.setStorageSync(recentKey(partyType), next); Taro.setStorageSync(usageKey(partyType), nextUsage); } catch { /* storage is optional */ }
      setStoredRecent(next);
      setUsage(nextUsage);
    }
    setOpen(false);
    setQuery('');
    onSelect(party);
  };
  const selected = parties.find(party => party.id === selectedId && !party.deleted_at);

  return <View className={styles.root} data-testid={`${partyType}-search-picker`}>
    <Button className={styles.trigger} data-testid={`${partyType}-search-open`} disabled={disabled} onClick={() => setOpen(true)}>
      <Text>{selected?.name || `选择${title}`}</Text>
      <Text className={styles.triggerHint}>{selected?.contact || '点击搜索并选择'}</Text>
    </Button>
    {open && <View className={styles.mask} onClick={() => setOpen(false)}>
      <View className={styles.sheet} role='dialog' aria-modal='true' aria-label={`选择${title}`} data-party-search-sheet={partyType} onClick={event => event.stopPropagation()}>
        <View className={styles.heading}><View><Text className={styles.title}>选择{title}</Text>
          <Text className={styles.subtitle}>可按名称、联系人、电话或常用货物搜索</Text></View>
          <Button className={styles.close} aria-label='关闭选择面板' onClick={() => setOpen(false)}>×</Button></View>
        <View className={styles.search}><Input autoFocus value={query} placeholder={`搜索${title}或货物名称`}
          aria-label={`搜索${title}或货物名称`} onInput={event => setQuery(event.detail.value)} /></View>
        <Button className={styles.unlinked} data-testid={`${partyType}-search-unlinked`} disabled={disabled} onClick={() => choose(null)}>
          不关联{title}<Text>只办理库存业务</Text>
        </Button>
        <View className={styles.list} data-testid={`${partyType}-search-results`}>
          {visible.map(party => <Button className={styles.party} key={party.id} disabled={disabled} data-testid={`${partyType}-search-result-${party.id}`}
            onClick={() => choose(party)}>
            <View className={styles.partyMain}><Text className={styles.partyName}>{party.name}</Text>
              <Text className={styles.partyMeta}>{[party.contact, party.phone].filter(Boolean).join(' · ') || '暂无联系人信息'}</Text>
              <Text className={styles.goodsSummary}>{(party.specs || []).length ? `常用货物：${(party.specs || []).slice(0, 3).map(item => item.goods || '未命名货物').join('、')}` : '暂无常用货物'}</Text>
              {(recentOrder.includes(party.id) || usage[party.id] > 1) && <Text className={styles.history}>{recentOrder.includes(party.id) ? '最近使用' : '常用对象'}</Text>}
            </View>
            {party.id === selectedId && <Text className={styles.selected}>已选择</Text>}
          </Button>)}
          {!visible.length && <Text className={styles.empty}>{query ? '没有匹配结果' : `还没有${title}资料`}</Text>}
        </View>
      </View>
    </View>}
  </View>;
}

type GoodsCardsProps = {
  items: PartyGood[];
  editable?: boolean;
  disabled?: boolean;
  onSelect?: (item: PartyGood) => void;
  onEdit?: (item: PartyGood) => void;
  onRemove?: (id: string | number) => void;
};

export function isPartyGoodComplete(item: PartyGood): boolean {
  const price = item.unitPrice ?? item.price;
  const size = (item.category === '纸板' || item.kind === '纸板') && Number(item.boardLength) > 0 && Number(item.boardWidth) > 0
    ? `${item.boardLength}×${item.boardWidth}` : item.specification;
  return Boolean(item.goods?.trim() && size?.trim() && item.material?.trim() && item.unit?.trim()
    && price != null && Number.isFinite(Number(price)) && Number(price) >= 0);
}

export function GoodsCards({ items, editable = false, disabled = false, onSelect, onEdit, onRemove }: GoodsCardsProps) {
  if (!items.length) return <Text className={styles.goodsEmpty}>暂无常用货物</Text>;
  return <View className={styles.goodsCards} data-testid='party-goods-cards'>
    {items.map(item => {
      const category = item.category || (item.kind === '纸板' ? '纸板' : '纸箱');
      const price = item.unitPrice ?? item.price;
      const size = category === '纸板' && item.boardLength != null && item.boardWidth != null
        ? `${item.boardLength}×${item.boardWidth} cm` : item.specification;
      const full = isPartyGoodComplete(item);
      const card = <>
        <View className={styles.goodsHeading}><Text className={styles.goodsName}>{item.goods || '未命名货物'}</Text>
          <Text className={full ? styles.complete : styles.incomplete}>{full ? '资料完整' : '资料不完整'}</Text></View>
        <Text className={styles.goodsKind}>{category}</Text>
        {category === '纸板' && (item.cartonLength != null || item.fluteType || item.layers != null) && <Text className={styles.goodsDetail}>
          成箱尺寸：{item.cartonLength ?? '未记录'}×{item.cartonWidth ?? '未记录'}×{item.cartonHeight ?? '未记录'} cm · {item.fluteType || '楞型未记录'} · {item.layers == null ? '层数未记录' : `${item.layers}层`}
        </Text>}
        <View className={styles.goodsFields}>
          <Text>尺寸：{size?.trim() || '尺寸未记录'}</Text>
          <Text>材质：{item.material?.trim() || '材质未记录'}</Text>
          <Text>单位：{item.unit?.trim() || '单位未记录'}</Text>
          <Text>价格：{price == null ? '价格未记录' : `¥${price}`}</Text>
        </View>
        {editable && <View className={styles.goodsActions}>
          {onEdit && <Button className={styles.edit} disabled={disabled} onClick={event => { event.stopPropagation(); onEdit(item); }}>编辑</Button>}
          {onRemove && <Button className={styles.remove} disabled={disabled} onClick={event => { event.stopPropagation(); onRemove(item.id); }}>删除</Button>}
        </View>}
      </>;
      return onSelect
        ? <Button className={styles.goodsCard} key={item.id} disabled={disabled} data-testid={`party-good-${item.id}`} onClick={() => onSelect(item)}>{card}</Button>
        : <View className={styles.goodsCard} key={item.id} data-testid={`party-good-${item.id}`}>{card}</View>;
    })}
  </View>;
}

export type { PartySearchPanelProps, GoodsCardsProps };
