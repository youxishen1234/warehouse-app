import { request } from './request';
export interface BusinessSpecification {
  id: string; source: 'board' | 'product' | 'customer'; source_id: string; kind: '纸板' | '成品'; name: string;
  board?: number[]; carton?: number[]; material: string; fluteType?: string; layers?: number; updated_at: number;
  customer_name?: string;
}
export interface ProductionRecord {
  id: string; batch_id: string; product_id: number; product_name: string; specification: string; unit: string;
  consumed_quantity: number; quantity: number; transaction_id: number; operator: string; remark: string; created_at: number;
  specification_snapshot: { board: number[]; carton: number[]; size_unit: 'cm'; flute_type: string; layers: number };
}
export const getBusinessSpecifications = () => request<BusinessSpecification[]>({ url: '/api/business-specifications' });
export const getProduction = () => request<ProductionRecord[]>({ url: '/api/production' });
export const completeProduction = (data: { batch_id: string; product_id?: number; product_name?: string; consumed_quantity: number; quantity: number; remark: string }) => request<ProductionRecord>({ url: '/api/production', method: 'POST', data });
