import { useEffect } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';

/** Keep legacy deep links working while the unified finance center owns the UI. */
export default function LedgerPage() {
  const { params } = useRouter();
  useEffect(() => {
    const target = new URLSearchParams();
    target.set('section', 'finance');
    const partyType = params.party_type === 'customer' || params.party_type === 'supplier' ? params.party_type : '';
    const view = params.view === 'customer' || params.view === 'supplier' || params.view === 'ledger'
      ? params.view
      : partyType || 'ledger';
    target.set('view', view);
    if (partyType) target.set('party_type', partyType);
    if (params.party_id) target.set('party_id', String(params.party_id));
    if (params.party_name) target.set('party_name', String(params.party_name));
    if (params.entry) target.set('entry', String(params.entry));
    void Taro.redirectTo({ url: `/pages/business-center/index?${target.toString()}` });
  }, [params]);

  return <View role='status' aria-label='正在打开收付款中心'>
    <Text>正在打开收付款中心…</Text>
  </View>;
}
