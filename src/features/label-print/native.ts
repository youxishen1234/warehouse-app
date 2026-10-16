import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { LabelKind, LabelSnapshot } from './index';

export interface MediaProfile {
  profileId: string;
  printerName: string;
  widthMm: number;
  heightMm: number;
  paperStyle: 'gap';
  density: number;
  marginMm: { top: number; right: number; bottom: number; left: number };
  calibrated: boolean;
}
export interface LabelPrinterState {
  supported: boolean;
  connected: boolean;
  printerName?: string;
  mediaProfiles: MediaProfile[];
  productionEnabled: boolean;
  maxCopies: number;
  hardwareBusy?: boolean;
  reason?: string;
}
export interface LabelPrinter { printerName: string; connected: boolean; ambiguous?: boolean }
export type PrintPhase = 'scanning' | 'connecting' | 'rendering' | 'submitting' | 'printing' | 'ending' | 'sdk-completed' | 'failed' | 'cancelled' | 'uncertain';
export interface PrintProgress {
  jobId: string;
  phase: PrintPhase;
  total: number;
  outcomeConfidence: 'sdk-confirmed' | 'count-verified' | 'unknown';
  printed?: number;
  errorCode?: string;
  message?: string;
  kind?: LabelKind | 'calibration';
  profileId?: string;
  createdAt?: string | number;
  businessId?: string | number;
  requiresResolution?: boolean;
}
export interface LabelPreviewInput { kind: LabelKind; templateVersion: 1; profileId: string; data: LabelSnapshot }
interface OfficialLabelPrinterPlugin {
  getState(): Promise<LabelPrinterState>;
  scanPrinters(): Promise<{ printers: LabelPrinter[] }>;
  connectPrinter(input: { printerName: string; modelConfirmed: true }): Promise<void>;
  saveMediaProfile(input: { profile: MediaProfile }): Promise<void>;
  previewLabel(input: LabelPreviewInput): Promise<{ imageBase64: string; warnings: string[] }>;
  printLabel(input: LabelPreviewInput & { jobId: string; copies: number }): Promise<void>;
  getActiveJob(): Promise<{ job: PrintProgress | null }>;
  getRecentJobs(): Promise<{ jobs: PrintProgress[] }>;
  cancelPrint(input: { jobId: string }): Promise<PrintProgress>;
  disconnectPrinter(): Promise<void>;
  printCalibration(input: { jobId: string; profileId: string; acknowledged: true }): Promise<void>;
  confirmCalibration(input: { profileId: string; jobId: string; acknowledged: true }): Promise<void>;
  addListener(event: 'progress', callback: (progress: PrintProgress) => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<OfficialLabelPrinterPlugin>('OfficialLabelPrinter');
const unavailableReason = '精臣 K3 直连仅支持安装了新版原生插件的 iOS App；本页仍可浏览记录与字段。';
const available = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('OfficialLabelPrinter');
function requireNative(): void { if (!available()) throw new Error(unavailableReason); }
export const labelPrinter = {
  async getState(): Promise<LabelPrinterState> {
    if (!available()) return { supported: false, connected: false, mediaProfiles: [], productionEnabled: false, maxCopies: 1, reason: unavailableReason };
    return plugin.getState();
  },
  async scanPrinters() { requireNative(); return plugin.scanPrinters(); },
  async connectPrinter(printerName: string) { requireNative(); return plugin.connectPrinter({ printerName, modelConfirmed: true }); },
  async saveMediaProfile(profile: MediaProfile) { requireNative(); return plugin.saveMediaProfile({ profile }); },
  async previewLabel(input: LabelPreviewInput) { requireNative(); return plugin.previewLabel(input); },
  async printLabel(input: LabelPreviewInput & { jobId: string; copies: number }) { requireNative(); return plugin.printLabel(input); },
  async getActiveJob(): Promise<{ job: PrintProgress | null }> { return available() ? plugin.getActiveJob() : { job: null }; },
  async getRecentJobs(): Promise<{ jobs: PrintProgress[] }> { return available() ? plugin.getRecentJobs() : { jobs: [] }; },
  async cancelPrint(jobId: string) { requireNative(); return plugin.cancelPrint({ jobId }); },
  async disconnectPrinter() { requireNative(); return plugin.disconnectPrinter(); },
  async printCalibration(jobId: string, profileId: string) { requireNative(); return plugin.printCalibration({ jobId, profileId, acknowledged: true }); },
  async confirmCalibration(profileId: string, jobId: string) { requireNative(); return plugin.confirmCalibration({ profileId, jobId, acknowledged: true }); },
  async addProgressListener(callback: (progress: PrintProgress) => void): Promise<PluginListenerHandle> {
    if (!available()) return { remove: async () => {} };
    return plugin.addListener('progress', callback);
  }
};
export const isActivePrintJob = (job: PrintProgress | null): boolean => Boolean(job && (job.requiresResolution === true || !['sdk-completed', 'failed', 'cancelled', 'uncertain'].includes(job.phase)));
