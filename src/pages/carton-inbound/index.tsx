import { View } from '@tarojs/components';
import Workbench from '@/components/Workspace/workbench';
import CartonInbound from '@/features/carton-inbound';

export default function Page() {
  return <View data-tab-route='/pages/inventory/index'>
    <Workbench embedded initial='stock' />
    <CartonInbound />
  </View>;
}
