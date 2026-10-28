export interface PrintNoteCustomerSpecSnapshot { id: string; goods: string; specification: string; material: string; unit: '个'; price: number; }
export interface PrintNoteItem {
  product_id?: number | null;
  product_customer_id?: number | null;
  customer_spec_id?: string;
  customer_spec_snapshot?: PrintNoteCustomerSpecSnapshot;
  name: string;
  specification: string;
  unit: '个';
  quantity: number;
  price: number;
  amount: number;
  remark: string;
}
export interface PrintNoteInput { company: string; customer_id: number | null; customer_name: string; address: string; phone: string; receiver: string; sender: string; date: string; paper: '241-93' | '241-140' | 'a4'; items: PrintNoteItem[]; total: number; }
export interface SavedPrintNote extends PrintNoteInput { id: number; number: string; version: number; created_at: number; updated_at: number; temporary_print_at?: number; outbound_at?: number; outbound_no?: string; transaction_ids?: number[]; }
export interface DeletedPrintNote { id: number; number: string; deleted_at: number; }
export function normalizeSpecification(value: unknown): string;
export function validateNote(raw: unknown): PrintNoteInput;
