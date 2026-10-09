import type { DotMatrixSettings, PrintDocument } from './dot-matrix-print';

export interface LocalPrinter {
  name: string;
  displayName: string;
  isDefault: boolean;
  offline: boolean;
  unavailable: boolean;
  isPdf: boolean;
}

export interface LocalPrintRequest {
  id: string;
  printerName: string;
  document: PrintDocument;
  settings: DotMatrixSettings;
}

export interface LocalPrintBridge {
  version: 1;
  listPrinters(): Promise<LocalPrinter[]>;
  print(request: LocalPrintRequest): Promise<{ printerName: string; pages: number; kind: 'queued' | 'pdf'; pdf?: string }>;
}

export function getLocalPrintBridge(): LocalPrintBridge | undefined {
  const bridge = typeof window !== 'undefined' ? (window as Window & { warehouseLocalPrint?: LocalPrintBridge }).warehouseLocalPrint : undefined;
  return bridge?.version === 1 && typeof bridge.listPrinters === 'function' && typeof bridge.print === 'function' ? bridge : undefined;
}

export function downloadPrintPdf(base64: string, number: string) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${number.replace(/[\\/:*?"<>|]/g, '_') || '单据'}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
