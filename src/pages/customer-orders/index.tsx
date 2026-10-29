import { useRouter } from '@tarojs/taro';
import { View } from '@tarojs/components';
import Workbench from '@/components/Workspace/workbench';
import CustomerOrders from '@/features/customer-orders';

export default function Page() {
  const { params } = useRouter();
  return <View data-tab-route='/pages/home/index'>
    {params.create === '1' && <Workbench embedded initial='home' />}
    <CustomerOrders />
  </View>;
}
