import { request } from './request';
import type { PhotoDraft } from './ledger-photos';
export type CustomerPhoto={id:string;customer_id:number;client_id:string;kind:'delivery';name:string;mime:string;size:number;sha256:string;created_at:number;status:'unreviewed'};
export const listCustomerPhotos=(customerId:number)=>request<CustomerPhoto[]>({url:`/api/customers/${customerId}/attachments`});
export const readCustomerPhoto=(customerId:number,id:string)=>request<{data:string}>({url:`/api/customers/${customerId}/attachments/${encodeURIComponent(id)}/content`,timeout:60000,retryAcrossOrigins:false});
export const uploadCustomerPhoto=(customerId:number,draft:PhotoDraft)=>request<CustomerPhoto>({url:`/api/customers/${customerId}/attachments`,method:'POST',data:{client_id:draft.client_id,kind:'delivery',name:draft.name,data:draft.data},requestIdentity:`customer-photo:${customerId}:${draft.client_id}`,timeout:90000,retryAcrossOrigins:false});
