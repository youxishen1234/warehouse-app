import type { CustomerOrder } from '@/types';
import { request } from './request';

export interface DimensionSpec {
  id: string; goods: string; size: string; sizeUnit: string; material: string; unit: string; kind: '成品' | '纸板';
}
export interface DimensionCustomer { id: string; name: string; specs: DimensionSpec[] }
export interface DimensionDocument {
  schemaVersion: number; revision: number; customers: DimensionCustomer[];
  theme: { title: string; accent: string; bg: string; card: string };
}
export const getCustomerDimensions = () => request<DimensionDocument>({ url: '/api/customer-dimensions' });
// Send the document revision captured when editing began. A concurrent edit
// must be rejected by the server rather than replacing another device's work.
export const saveCustomerDimensions = (data: DimensionDocument) =>
  request<DimensionDocument>({ url: '/api/customer-dimensions', method: 'PUT', data });
export const orderFromDimension = (data: { customer_id: string; spec_id: string; quantity: number; unit_price: number }) =>
  request<CustomerOrder>({ url: '/api/customer-dimensions/order', method: 'POST', data });
