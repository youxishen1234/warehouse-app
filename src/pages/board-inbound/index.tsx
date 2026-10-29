import { View } from '@tarojs/components';
import Workbench from '@/components/Workspace/workbench';
import BoardInbound from '@/features/board-inbound';

export default function Page() {
  return <View data-tab-route='/pages/inventory/index'>
    <Workbench embedded initial='stock' />
    <BoardInbound />
  </View>;
}
