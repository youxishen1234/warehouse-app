import { View } from '@tarojs/components';
import Receipt from './Receipt';
import Shipment from './Shipment';
import Orders from './Orders';
import Transactions from './Transactions';
import PaperboardReceipt from './PaperboardReceipt';
import PaperboardBatch from './PaperboardBatch';
import PaperboardMovement from './PaperboardMovement';
import StockScanner from './StockScanner';
import Labels from './Labels';
import LabelLookup from './LabelLookup';
import TeamSettings from './TeamSettings';
import BackupSettings from './BackupSettings';
import PartyDetails from './PartyDetails';
import CustomerOriginals from './CustomerOriginals';
import GoodsCatalog from './GoodsCatalog';
import DimensionCalculator from './DimensionCalculator';
import CartonCalculator from './CartonCalculator';

const forms = {
  receipt: Receipt,
  shipment: Shipment,
  orders: Orders,
  transactions: Transactions,
  'paperboard-receipt': PaperboardReceipt,
  'paperboard-batch': PaperboardBatch,
  'paperboard-movement': PaperboardMovement,
  'stock-scanner': StockScanner,
  labels: Labels,
  'label-lookup': LabelLookup,
  team: TeamSettings,
  backup: BackupSettings,
  'party-details': PartyDetails,
  originals: CustomerOriginals,
  goods: GoodsCatalog,
  dimensions: DimensionCalculator,
  'carton-dimensions': CartonCalculator
};

export function isBusinessForm(value?: string): value is keyof typeof forms {
  return Boolean(value && Object.prototype.hasOwnProperty.call(forms, value));
}

export default function BusinessForm({ section }: { section: keyof typeof forms }) {
  const Screen = forms[section];
  const owner = section === 'labels' ? 'print-center'
    : ['backup', 'team'].includes(section) ? 'mine'
      : ['paperboard-batch', 'paperboard-movement', 'label-lookup', 'stock-scanner', 'goods'].includes(section) ? 'inventory'
        : 'home';
  return <View className='business-sheet-screen' data-ui-version='demo-layout-v1' data-tab-route={`/pages/${owner}/index`}>
    <Screen />
  </View>;
}
