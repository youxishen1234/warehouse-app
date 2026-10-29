import Taro from '@tarojs/taro';

const TRANSPORT_KEY = 'warehouse_print_transport_v1';
export type PrintTransport = 'bluetooth' | 'network';

export function readPreferredPrintTransport(bluetoothSupported: boolean): PrintTransport {
  if (!bluetoothSupported) return 'network';
  try { return Taro.getStorageSync(TRANSPORT_KEY) === 'bluetooth' ? 'bluetooth' : 'network'; }
  catch { return 'network'; }
}

export function savePreferredPrintTransport(value: PrintTransport): void {
  Taro.setStorageSync(TRANSPORT_KEY, value);
}
