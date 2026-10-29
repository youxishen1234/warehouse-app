/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Image, Input, Text, View } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { getProductsPage } from '@/services/api';
import { getBoards } from '@/services/boards';
import type { BoardBatch } from '@/services/boards';
import type { Product } from '@/types';
import { buildBoardLabelSnapshot, buildFinishedLabelSnapshot, changedSnapshotFields, fetchLatestLabelRecord, LABEL_TEMPLATE_VERSION } from '@/features/label-print';
import type { BoardLabelOptions, FinishedLabelOptions, LabelKind, LabelSnapshot } from '@/features/label-print';
import { isActivePrintJob, labelPrinter } from '@/features/label-print/native';
import type { LabelPrinter, LabelPrinterState, MediaProfile, PrintProgress } from '@/features/label-print/native';
import RemoteLabelPrintPage from '@/components/BusinessForms/Labels/remote';
import styles from '@/components/BusinessForms/Labels/index.module.scss';

type RecordChoice = { kind: 'finished-product'; data: Product } | { kind: 'paperboard-batch'; data: BoardBatch };
type FieldOption = { key: string; title: string };
const productOptions: FieldOption[] = [{ key: 'material', title: '材质' }, { key: 'corrugation', title: '楞型' }, { key: 'layers', title: '层数' }, { key: 'weight', title: '克重' }, { key: 'printedAt', title: '打印日期' }, { key: 'stockSnapshot', title: '打印时库存' }];
const boardOptions: FieldOption[] = [{ key: 'layers', title: '层数' }, { key: 'faceGsm', title: '面纸克重' }, { key: 'linerGsm', title: '里纸克重' }, { key: 'flutingGsm', title: '楞纸克重' }, { key: 'cartonDimensions', title: '纸箱尺寸' }, { key: 'receivedDate', title: '入库日期' }, { key: 'location', title: '库位' }, { key: 'receivedQty', title: '实收数量' }, { key: 'remainingQtySnapshot', title: '打印时余量' }];
const names: Record<string, string> = { name: '商品名称', specification: '规格', unit: '库存单位', productId: '商品 ID', batchId: '批次号', boardLength: '纸板长', boardWidth: '纸板宽', fluteType: '楞型', supplier: '板厂', material: '材质', corrugation: '楞型', layers: '层数', weight: '克重', stockSnapshot: '打印时库存', printedAt: '打印日期', faceGsm: '面纸克重', linerGsm: '里纸克重', flutingGsm: '楞纸克重', cartonLength: '纸箱长', cartonWidth: '纸箱宽', cartonHeight: '纸箱高', receivedDate: '入库日期', location: '库位', receivedQty: '实收数量', remainingQtySnapshot: '打印时余量' };
const phases: Record<string, string> = { scanning: '搜索设备中', connecting: '连接中', rendering: '正在准备', submitting: '数据提交中', printing: '等待 SDK 状态', ending: '等待 SDK 结束', 'sdk-completed': 'SDK 任务完成', failed: '任务失败', cancelled: '已取消，请检查实物', uncertain: '结果未确认，请检查实物' };
const initialState: LabelPrinterState = { supported: false, connected: false, mediaProfiles: [], productionEnabled: false, maxCopies: 1, reason: '正在检查打印机能力…' };
const defaultMedia = { widthMm: '70', heightMm: '100', density: '3', top: '', right: '', bottom: '', left: '' };
const mediaFromProfile = (item: MediaProfile) => ({ widthMm: String(item.widthMm), heightMm: String(item.heightMm), density: String(item.density), top: String(item.marginMm.top), right: String(item.marginMm.right), bottom: String(item.marginMm.bottom), left: String(item.marginMm.left) });
const PAGE_SIZE = 12;
const errorText = (error: unknown) => {
  if (typeof error === 'string' && error.trim()) return error;
  const value = error as { message?: unknown; errMsg?: unknown; localizedDescription?: unknown; errorDescription?: unknown; code?: unknown; error?: unknown } | null;
  const detail = [value?.message, value?.errMsg, value?.localizedDescription, value?.errorDescription, value?.error]
    .find(item => typeof item === 'string' && item.trim()) as string | undefined;
  if (detail) return `${detail}${typeof value?.code === 'string' && value.code ? ` (${value.code})` : ''}`;
  if (error instanceof Error && error.message) return error.message;
  return '操作失败，请重试';
};
const jobId = () => `label-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const disabledIf = (condition: boolean) => condition ? true : undefined;
const idOf = (record: RecordChoice) => String(record.data.id);
const openIOSDownload = () => {
  if (typeof window !== 'undefined') {
    window.open('https://youxishen.online/download/', '_blank', 'noopener');
    return;
  }
  void Taro.switchTab({ url: '/pages/mine/index' });
};
function snapshotOf(record: RecordChoice, finished: FinishedLabelOptions, board: BoardLabelOptions, at: string): LabelSnapshot {
  if (record.kind === 'finished-product') return buildFinishedLabelSnapshot(record.data, finished, at);
  // Existing installed native binaries have a strict v1 field whitelist.
  // The business template is a USB/PC feature; preserve the Bluetooth DTO.
  const snapshot = { ...buildBoardLabelSnapshot(record.data, board) };
  delete snapshot.customerName;
  delete snapshot.material;
  delete snapshot.printPlate;
  delete snapshot.printColor;
  return Object.freeze(snapshot);
}
function fieldValue(key: string, value: unknown, data: LabelSnapshot): string {
  if (['boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight'].includes(key)) return `${value} cm`;
  if (['weight', 'faceGsm', 'linerGsm', 'flutingGsm'].includes(key)) return `${value} g/m²`;
  if (['receivedQty', 'remainingQtySnapshot'].includes(key)) return `${value} 张`;
  if (key === 'stockSnapshot' && 'unit' in data) return `${value} ${data.unit}`;
  if (key === 'printedAt') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false });
  return String(value);
}

export function NativeLabelPrintPage({ onComputer }: { onComputer?: () => void } = {}) {
  const router = useRouter();
  const [kind, setKind] = useState<LabelKind>(router.params.kind === 'paperboard-batch' ? 'paperboard-batch' : 'finished-product');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<RecordChoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<RecordChoice | null>(null);
  const [finishedOptions, setFinishedOptions] = useState<FinishedLabelOptions>({});
  const [boardFields, setBoardFields] = useState<BoardLabelOptions>({});
  const [frozenAt, setFrozenAt] = useState(() => new Date().toISOString());
  const [printer, setPrinter] = useState(initialState);
  const [printers, setPrinters] = useState<LabelPrinter[]>([]);
  const [settings, setSettings] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [media, setMedia] = useState(defaultMedia);
  const [copies, setCopies] = useState('1');
  const [operation, setOperation] = useState('');
  const [operationElapsed, setOperationElapsed] = useState(0);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [stateReadError, setStateReadError] = useState('');
  const [jobReadError, setJobReadError] = useState('');
  const [historyReadError, setHistoryReadError] = useState('');
  const [connectingName, setConnectingName] = useState('');
  const [connectionWarning, setConnectionWarning] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [job, setJob] = useState<PrintProgress | null>(null);
  const [recent, setRecent] = useState<PrintProgress[]>([]);
  const [preview, setPreview] = useState<{ key: string; image: string; warnings: string[] } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const alive = useRef(true);
  const actionLock = useRef(false);
  const cancelLock = useRef(false);
  const listGeneration = useRef(0);
  const choiceGeneration = useRef(0);
  const eventRevision = useRef(0);
  const currentJob = useRef<PrintProgress | null>(null);
  const stateGeneration = useRef(0);
  useEffect(() => {
    if (!operation) { setOperationElapsed(0); return; }
    const startedAt = Date.now();
    setOperationElapsed(0);
    const timer = setInterval(() => { if (alive.current) setOperationElapsed(Math.floor((Date.now() - startedAt) / 1000)); }, 1000);
    return () => clearInterval(timer);
  }, [operation]);
  const busy = Boolean(operation) || printer.hardwareBusy === true || isActivePrintJob(job);
  const profile = printer.mediaProfiles.find(item => item.profileId === profileId && item.printerName === printer.printerName);
  const maxCopies = Math.max(1, Math.floor(printer.maxCopies || 1));
  const copyCount = Number(copies);
  const copiesValid = /^\d+$/.test(copies) && Number.isSafeInteger(copyCount) && copyCount >= 1 && copyCount <= maxCopies;

  const applyJob = useCallback((next: PrintProgress | null) => {
    if (!alive.current) return;
    currentJob.current = next; setJob(next);
  }, []);
  const refreshPrinter = useCallback(async () => {
    const generation = ++stateGeneration.current;
    const revision = eventRevision.current;
    const current = () => alive.current && generation === stateGeneration.current;
    let activeRead: PrintProgress | null = null;
    let historyRead: PrintProgress[] = [];
    const applyReadJobs = () => {
      if (revision === eventRevision.current) applyJob(activeRead || historyRead.find(item => item.jobId === currentJob.current?.jobId) || currentJob.current || historyRead[0] || null);
    };
    // Task records are auxiliary: a rejected or stalled query must not hide getState.
    void labelPrinter.getActiveJob().then(active => {
      if (!current()) return;
      setJobReadError(''); activeRead = active.job; applyReadJobs();
    }).catch(error => { if (current()) setJobReadError(`活动任务读取失败：${errorText(error)}`); });
    void labelPrinter.getRecentJobs().then(history => {
      if (!current()) return;
      setHistoryReadError(''); historyRead = history.jobs; setRecent(history.jobs.slice(0, 10)); applyReadJobs();
    }).catch(error => { if (current()) setHistoryReadError(`任务记录读取失败：${errorText(error)}`); });
    try {
      const state = await labelPrinter.getState();
      if (current()) {
        setStateReadError(''); setPrinter(state);
        setProfileId(previous => state.mediaProfiles.some(item => item.profileId === previous && item.printerName === state.printerName) ? previous : state.mediaProfiles.find(item => item.printerName === state.printerName)?.profileId || '');
        return state;
      }
      return undefined;
    } catch (error) { if (current()) setStateReadError(`打印机状态读取失败：${errorText(error)}`); return undefined; }
  }, [applyJob]);
  useDidShow(() => { void refreshPrinter(); });
  useEffect(() => {
    alive.current = true; let listener: { remove(): Promise<void> } | undefined;
    void labelPrinter.addProgressListener(next => {
      if (!alive.current) return;
      if (isActivePrintJob(currentJob.current) && currentJob.current?.jobId !== next.jobId) return;
      eventRevision.current += 1; applyJob(next);
      if (!isActivePrintJob(next)) void refreshPrinter();
    }).then(handle => { if (alive.current) listener = handle; else void handle.remove(); }).catch(error => { if (alive.current) setActionError(`连接打印机进度通知失败：${errorText(error)}`); });
    void refreshPrinter();
    return () => { alive.current = false; choiceGeneration.current += 1; listGeneration.current += 1; void listener?.remove(); };
  }, [applyJob, refreshPrinter]);

  useEffect(() => {
    const generation = ++listGeneration.current; setLoading(true); setListError('');
    const timer = setTimeout(() => {
      const search = query.trim();
      const load = async () => {
        if (kind === 'finished-product') {
          const result = await getProductsPage({ page, page_size: PAGE_SIZE, keyword: search, sort: 'name', order: 'asc' });
          return { items: result.items.filter(item => !item.deleted_at).map(data => ({ kind: 'finished-product' as const, data })), total: result.total };
        }
        const batches = await getBoards();
        const filtered = batches.filter(batch => !search || [batch.id, batch.supplier, batch.fluteType, batch.boardLength + '×' + batch.boardWidth, batch.boardLength + ' × ' + batch.boardWidth, batch.location].join(' ').toLowerCase().includes(search.toLowerCase()));
        return { items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(data => ({ kind: 'paperboard-batch' as const, data })), total: filtered.length };
      };
      void load().then(value => { if (alive.current && generation === listGeneration.current) { setResults(value.items); setTotal(value.total); } }).catch(error => { if (alive.current && generation === listGeneration.current) { setResults([]); setListError(errorText(error)); } }).finally(() => { if (alive.current && generation === listGeneration.current) setLoading(false); });
    }, 300);
    return () => { clearTimeout(timer); listGeneration.current += 1; };
  }, [kind, query, page, reload]);

  const selectRecord = useCallback(async (nextKind: LabelKind, id: string) => {
    if (actionLock.current || isActivePrintJob(currentJob.current)) return;
    const generation = ++choiceGeneration.current; setActionError(''); setNotice('正在读取最新资料…');
    setSelected(null); setRefreshRequired(false);
    try {
      const choice: RecordChoice = nextKind === 'finished-product' ? { kind: nextKind, data: await fetchLatestLabelRecord(nextKind, id) } : { kind: nextKind, data: await fetchLatestLabelRecord(nextKind, id) };
      if (!alive.current || generation !== choiceGeneration.current) return;
      setKind(nextKind); setSelected(choice); setFrozenAt(new Date().toISOString()); setNotice('');
    } catch (error) { if (alive.current && generation === choiceGeneration.current) { setActionError(errorText(error)); setNotice(''); } }
  }, []);
  useEffect(() => {
    if (router.params.id) void selectRecord(router.params.kind === 'paperboard-batch' ? 'paperboard-batch' : 'finished-product', router.params.id);
    // Route shortcuts are consumed once; changing templates is a user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const built = useMemo(() => {
    if (!selected) return { data: null, error: '' };
    try { return { data: snapshotOf(selected, finishedOptions, boardFields, frozenAt), error: '' }; }
    catch (error) { return { data: null, error: errorText(error) }; }
  }, [selected, finishedOptions, boardFields, frozenAt]);
  const previewKey = built.data && profile ? JSON.stringify({ kind, data: built.data, profile }) : '';
  useEffect(() => {
    let valid = true; setPreviewLoading(false);
    if (!built.data || !profile || !printer.supported) { setPreview(null); setPreviewError(''); return () => { valid = false; }; }
    if (busy || preview?.key === previewKey) return () => { valid = false; };
    setPreview(null); setPreviewError(''); setPreviewLoading(true);
    const timer = setTimeout(() => {
      void labelPrinter.previewLabel({ kind, templateVersion: LABEL_TEMPLATE_VERSION, profileId: profile.profileId, data: built.data! }).then(value => {
        if (valid && alive.current) {
          if (!value.imageBase64) throw new Error('SDK 没有返回预览图，请检查媒体配置');
          setPreview({ key: previewKey, image: value.imageBase64.startsWith('data:image/') ? value.imageBase64 : `data:image/png;base64,${value.imageBase64}`, warnings: value.warnings || [] });
        }
      }).catch(error => { if (valid && alive.current) setPreviewError(errorText(error)); }).finally(() => { if (valid && alive.current) setPreviewLoading(false); });
    }, 250);
    return () => { valid = false; clearTimeout(timer); };
    // The serialized key binds every DTO field and media parameter to this image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, printer.supported, busy]);

  const run = async (title: string, work: () => Promise<void>, allowResolution = false) => {
    if (actionLock.current || ((printer.hardwareBusy || isActivePrintJob(currentJob.current)) && !(allowResolution && currentJob.current?.requiresResolution))) return;
    actionLock.current = true; setOperation(title); setActionError(''); setNotice('');
    try { await work(); } catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { actionLock.current = false; if (alive.current) { setOperation(''); void refreshPrinter(); } }
  };
  const connect = (device: LabelPrinter) => void run('等待确认打印机型号…', async () => {
    if (device.ambiguous) throw new Error('发现同名打印机，暂时无法区分。请只打开一台打印机后重新搜索。');
    const confirmed = await Taro.showModal({ title: '核对打印机铭牌', content: `请确认「${device.printerName}」的铭牌型号为 K3，且为您当前操作的设备。K3_W 不适用。`, confirmText: '确认 K3' });
    if (confirmed.confirm !== true || !alive.current) return;
    setConnectingName(device.printerName); setConnectionWarning(''); setOperation(`正在连接 · ${device.printerName}…`);
    // Feedback only: JS timeout is not native cancellation and never releases the lock.
    const watchdog = setTimeout(() => {
      if (alive.current) setConnectionWarning('连接结果未确认，连接或状态核对尚未完成。可点击“刷新状态”查看真实状态；当前连接不会自动重试，扫描与打印仍保持暂停。');
    }, 35000);
    try {
      await labelPrinter.connectPrinter(device.printerName);
      if (!alive.current) return;
      setOperation(`正在核对连接状态 · ${device.printerName}…`);
      const verification = refreshPrinter();
      const verificationGeneration = stateGeneration.current;
      const state = await verification;
      if (!alive.current || verificationGeneration !== stateGeneration.current) return;
      if (!state) throw new Error('连接请求已返回，但未能读取真实连接状态，请点击“刷新状态”核对。');
      if (!state.connected || state.printerName !== device.printerName) throw new Error('SDK 未确认目标 K3 已连接，请检查蓝牙、设备距离及是否被其他 App 占用。');
      const saved = state.mediaProfiles.find(item => item.printerName === state.printerName);
      setMedia(saved ? mediaFromProfile(saved) : defaultMedia);
      setNotice(saved ? `已连接 ${state.printerName}。已载入已保存的 ${saved.widthMm} × ${saved.heightMm} mm 纸张配置。` : `已连接 ${state.printerName}。纸张默认 70 × 100 mm，请核对实物并打印单张校准样张。`);
    } finally {
      clearTimeout(watchdog);
      if (alive.current) { setConnectingName(''); setConnectionWarning(''); }
    }
  });
  const saveMedia = () => void run('保存纸张配置…', async () => {
    if (!printer.connected || !printer.printerName) throw new Error('请先连接并确认 K3 打印机');
    const values = Object.fromEntries(Object.entries(media).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)]));
    if (!Object.values(values).every(value => Number.isFinite(value))) throw new Error('请填写实测宽高、浓度和四边边距；边距为 0.5–30 mm');
    if (values.widthMm < 20 || values.widthMm > 120 || values.heightMm < 20 || values.heightMm > 200 || !Number.isInteger(values.density) || values.density < 1 || values.density > 5 || ['top', 'right', 'bottom', 'left'].some(key => values[key] < 0.5 || values[key] > 30)) throw new Error('当前模板支持宽 20–120 mm、高 20–200 mm，浓度 1–5，四边边距各 0.5–30 mm');
    if (values.left + values.right >= values.widthMm || values.top + values.bottom >= values.heightMm) throw new Error('边距合计必须小于实际纸张宽高');
    const confirmation = await Taro.showModal({ title: '确认实际耗材', content: `已实测标签 ${values.widthMm} × ${values.heightMm} mm，并确认当前安装的是间隙纸？保存后需重新打印校准样张。`, confirmText: '确认保存' });
    if (!confirmation.confirm || !alive.current) return;
    const nextId = profile?.profileId || `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await labelPrinter.saveMediaProfile({ profileId: nextId, printerName: printer.printerName, widthMm: values.widthMm, heightMm: values.heightMm, paperStyle: 'gap', density: values.density, marginMm: { top: values.top, right: values.right, bottom: values.bottom, left: values.left }, calibrated: false });
    setProfileId(nextId); setNotice('配置已保存。请打印一张校准样张，并检查实物。');
  });
  const calibrate = () => void run('准备校准样张…', async () => {
    if (!printer.connected) throw new Error('请先连接精臣 K3，再打印校准样张。');
    if (!profile) throw new Error('请先确认纸张为 70 × 100 mm，填好四边边距并点“保存纸张配置”。');
    const confirmation = await Taro.showModal({ title: '打印一张校准样张', content: '这会实际出纸。K3 的完成信号仍待真机验收，提交后可能显示“结果未确认”。请现场检查边界、走纸、边距和浓度；不要连续点击重试。', confirmText: '确认出纸' });
    if (!confirmation.confirm || !alive.current) return;
    await labelPrinter.printCalibration(jobId(), profile.profileId);
  });
  const calibrationJob = [job, ...recent].find(item => item && item.kind === 'calibration' && item.profileId === profile?.profileId);
  const confirmCalibration = () => void run('保存校准确认…', async () => {
    if (!profile) throw new Error('请先保存纸张配置。');
    if (!calibrationJob) throw new Error('还没有可核对的校准任务，请先点“打印校准样张”。');
    const confirmation = await Taro.showModal({ title: '核对校准实物', content: '请确认样张确实出纸，四边标记完整、方向与尺寸正确、走纸无偏移且浓度清晰。此确认只记录纸张校准，正式打印仍需完成 K3 与扫码路线验收。', confirmText: '已核对' });
    if (confirmation.confirm && alive.current) await labelPrinter.confirmCalibration(profile.profileId, calibrationJob.jobId);
  }, true);
  const recheckRecord = () => void run('重新在线校验资料…', async () => {
    if (!selected) return;
    setRefreshRequired(true);
    const fresh: RecordChoice = selected.kind === 'finished-product' ? { kind: selected.kind, data: await fetchLatestLabelRecord(selected.kind, idOf(selected)) } : { kind: selected.kind, data: await fetchLatestLabelRecord(selected.kind, idOf(selected)) };
    snapshotOf(fresh, finishedOptions, boardFields, frozenAt);
    if (!alive.current) return;
    setSelected(fresh); setRefreshRequired(false); setNotice('已重新读取最新资料，请核对字段与预览后再打印。');
  });
  const submit = () => void run('在线复核资料…', async () => {
    if (refreshRequired || !selected || !built.data || !profile || !copiesValid || !preview || preview.key !== previewKey || preview.warnings.length) throw new Error('请先完成有效的 SDK 预览、纸张配置和份数检查');
    const frozenPreview = preview; const expectedData = built.data; const expectedProfile = JSON.stringify(profile);
    setRefreshRequired(true);
    const fresh: RecordChoice = selected.kind === 'finished-product' ? { kind: selected.kind, data: await fetchLatestLabelRecord(selected.kind, idOf(selected)) } : { kind: selected.kind, data: await fetchLatestLabelRecord(selected.kind, idOf(selected)) };
    const freshData = snapshotOf(fresh, finishedOptions, boardFields, frozenAt);
    if (!alive.current) return;
    setRefreshRequired(false);
    const changed = changedSnapshotFields(expectedData, freshData);
    if (changed.length) { setSelected(fresh); setNotice(`资料已变化：${changed.map(field => names[field] || field).join('、')}。已更新字段，请核对新预览后再次点击打印。`); return; }
    const state = await labelPrinter.getState();
    if (!alive.current) return;
    setPrinter(state);
    const currentProfile = state.mediaProfiles.find(item => item.profileId === profile.profileId && item.printerName === state.printerName);
    if (!state.supported || !state.connected || !currentProfile || JSON.stringify(currentProfile) !== expectedProfile || !currentProfile.calibrated) throw new Error('打印机或纸张配置已变化，请重新连接并核对预览');
    if (!state.productionEnabled) throw new Error(state.reason || 'K3 真机和正式扫码路线尚未验收，正式打印暂未开放');
    if (copyCount > state.maxCopies) throw new Error('份数超过当前真机验收上限，请重新填写');
    if (fresh.kind === 'paperboard-batch' && fresh.data.remainingQty === 0) {
      const confirmation = await Taro.showModal({ title: '当前余量为 0', content: '本批次当前余量为 0。是否继续打印仅供识别的批次标签？打印不会更改库存。', confirmText: '继续打印' });
      if (!confirmation.confirm || !alive.current) return;
    }
    if (frozenPreview.key !== previewKey) throw new Error('预览已变化，请重新核对');
    await labelPrinter.printLabel({ jobId: jobId(), kind, templateVersion: LABEL_TEMPLATE_VERSION, profileId: profile.profileId, data: freshData, copies: copyCount });
  });
  const cancel = async () => {
    if (!job || !isActivePrintJob(job) || cancelLock.current) return;
    const confirmation = await Taro.showModal({ title: '取消当前任务', content: '部分标签可能已经出纸。取消后请先检查实物，系统不会自动重印。', confirmText: '取消任务' });
    if (!confirmation.confirm || !alive.current || cancelLock.current || currentJob.current?.jobId !== job.jobId || !isActivePrintJob(currentJob.current)) return;
    cancelLock.current = true; setCancelling(true);
    try { applyJob(await labelPrinter.cancelPrint(job.jobId)); } catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { cancelLock.current = false; if (alive.current) { setCancelling(false); void refreshPrinter(); } }
  };
  const chooseProfile = (item: MediaProfile) => {
    if (busy) return; setProfileId(item.profileId);
    setMedia(mediaFromProfile(item));
  };
  const switchKind = (next: LabelKind) => {
    if (busy || next === kind) return; choiceGeneration.current += 1; setKind(next); setSelected(null); setQuery(''); setPage(1); setNotice(''); setActionError(''); setRefreshRequired(false);
  };
  const optionState = kind === 'finished-product' ? finishedOptions : boardFields;
  const printDisabled = busy || refreshRequired || !printer.productionEnabled || !printer.connected || !profile?.calibrated || !built.data || !copiesValid || !preview || preview.key !== previewKey || preview.warnings.length > 0;
  const setupNextStep = !printer.supported
    ? '请先打开新版 iOS App，再连接精臣 K3。'
    : printer.hardwareBusy
      ? calibrationJob
        ? '打印机正在处理校准任务。请先检查实物：确认样张正常后点“已核对校准实物”；如果没有出纸，请在页面下方“当前任务”中取消。'
        : '打印机仍在处理上一个操作。请稍候并点“刷新状态”，不要重复提交。'
      : !printer.connected
        ? '第 1 步：点“搜索附近打印机”，选择精臣 K3 并核对铭牌型号。'
        : !profile
          ? '第 2 步：纸张已填 70 × 100 mm。补全四边边距后，点“保存纸张配置”。'
          : !profile.calibrated
            ? calibrationJob
              ? '第 3 步：检查刚打印的校准样张，确认尺寸、边距和浓度正常后，点“已核对校准实物”。'
              : '第 3 步：点“打印校准样张”会出一张纸，检查实物后再点“已核对校准实物”。'
            : '纸张已校准。现在可以在下方选择商品或纸板批次，生成标签预览。';
  const returnToDelivery = async () => {
    if (busy) return;
    try {
      const pages = Taro.getCurrentPages();
      if (pages.length > 1 && pages[pages.length - 2].route === 'pages/print-center/index') {
        await Taro.navigateBack();
      } else {
        await Taro.switchTab({ url: '/pages/print-center/index' });
      }
    } catch (error) { setActionError(errorText(error)); }
  };

  const printerFeedback = <View className='label-printer-feedback' aria-live='polite'>
    {(operation || printer.hardwareBusy) && <View className={styles.operationStatus}>
      {operation ? `${operation}${operationElapsed >= 5 ? ` ·已等待 ${operationElapsed} 秒` : ''}` : '打印机仍在处理上次操作，请刷新状态核对。'}
      {operationElapsed >= 20 && !cancelling ? '仍在等待打印机回执；如已出纸，请检查实物，等待结束后点“已核对校准实物”。' : ''}
    </View>}
    {connectionWarning && <View className={styles.notice}>{connectionWarning}</View>}
    {notice && <View className={styles.notice}>{notice}</View>}
    {actionError && <View className={styles.errorBox}>{actionError}</View>}
    {stateReadError && <View className={styles.errorBox}>{stateReadError}</View>}
    {(jobReadError || historyReadError) && <View className={styles.notice}>{[jobReadError, historyReadError].filter(Boolean).join('；')}。连接状态单独读取，不受任务记录查询影响。</View>}
  </View>;

  return <View className={styles.page}>
    <nav className={styles.printModes} aria-label='打印类型'>
      <button type='button' aria-pressed='false' disabled={busy} onClick={() => void returnToDelivery()}>送货单</button>
      <button type='button' aria-pressed='true'>标签打印</button>
      <button type='button' aria-pressed='false' disabled={busy} onClick={() => void Taro.reLaunch({ url: '/pages/print-center/index?mode=statement' })}>对账单</button>
    </nav>
    <View className={styles.hero}><Text className={styles.eyebrow}>仓库 · 标签</Text><Text className={styles.title}>标签工作台</Text><Text className={styles.subtitle}>选记录、核对字段，再用精臣 K3 打印。标签不会改变库存。</Text></View>
    <View className={styles.deviceBar}>
      <View className={styles.deviceStatus}><Text className={`label-printer-status ${styles.deviceName}`}>{connectingName ? operation : printer.connected ? `已连接 · ${printer.printerName}` : '尚未连接精臣 K3'}</Text><Text className={styles.meta}>{profile ? `${profile.widthMm} × ${profile.heightMm} mm · 间隙纸 · ${profile.calibrated ? '已确认校准' : '待校准'}` : '尚未配置实际纸张'}</Text></View>
      <View className={styles.deviceActions}>{onComputer && <Button className={styles.smallButton} disabled={disabledIf(busy)} onClick={onComputer}>电脑 USB 打印</Button>}<Button className={styles.smallButton} disabled={disabledIf(busy)} onClick={() => printer.supported ? setSettings(!settings) : openIOSDownload()}>{printer.supported && settings ? '收起设置' : printer.supported ? '打印机设置' : '打开安装页'}</Button></View>
    </View>
    {(!settings || !printer.supported) && printerFeedback}
    {!printer.productionEnabled && <View className={styles.notice}><Text>{printer.reason || 'K3 真机与正式扫码路线尚未验收，正式打印暂未开放。可先配置耗材并检查 SDK 预览。'}</Text>{!printer.supported && <Button className={styles.secondary} onClick={openIOSDownload}>去安装新版 iOS App</Button>}</View>}
    {settings && printer.supported && <View className={styles.card}>
      <Text className={styles.sectionTitle}>连接与纸张设置</Text><Text className={styles.meta}>请核对铭牌为 K3，测量当前纸卷；首版仅提供间隙纸。纸张默认 70 × 100 mm，如实测不同请修改。当前模板支持宽 20–120 mm、高 20–200 mm、四边边距各 0.5–30 mm，不代表已验收全部耗材。配置与任务只保存在本机。</Text>
      <View className={styles.setupGuide} aria-live='polite'><Text className={styles.setupGuideLabel}>当前下一步</Text><Text className={styles.setupGuideText}>{setupNextStep}</Text>{calibrationJob && <Text className={styles.setupGuideMeta}>校准任务：{phases[calibrationJob.phase] || calibrationJob.phase}{calibrationJob.message ? ` · ${calibrationJob.message}` : ''}</Text>}</View>
      <View className={styles.actions}><Button className={styles.secondary} loading={operation === '搜索附近打印机…'} disabled={disabledIf(!printer.supported || busy)} onClick={() => void run('搜索附近打印机…', async () => { const result = await labelPrinter.scanPrinters(); if (alive.current) { setPrinters(result.printers); setNotice(result.printers.length ? `找到 ${result.printers.length} 台设备，请核对铭牌后选择 K3。` : '未找到设备。请靠近打印机，确认蓝牙已开启并退出其他打印 App 后重试。'); } })}>搜索附近打印机</Button><Button className={styles.smallButton} onClick={() => void refreshPrinter()}>刷新状态</Button>{printer.connected && <Button className={styles.smallButton} disabled={disabledIf(busy)} onClick={() => void run('断开连接…', async () => { await labelPrinter.disconnectPrinter(); })}>断开</Button>}</View>
      {printerFeedback}
      {!printer.connected && <Text className={styles.meta}>请先搜索并连接精臣 K3；连接后才能保存纸张配置和打印校准样张。</Text>}
      {printers.map(device => <View key={device.printerName} className={`label-printer-device ${styles.printerRow}`}><Text>{device.printerName}{device.ambiguous ? ' · 同名设备，无法区分' : ''}</Text><Button className={styles.smallButton} loading={connectingName === device.printerName} disabled={disabledIf(busy || Boolean(device.ambiguous))} onClick={() => connect(device)}>{connectingName === device.printerName ? '正在连接…' : '选择并核对型号'}</Button></View>)}
      {printer.mediaProfiles.filter(item => item.printerName === printer.printerName).map(item => <Button key={item.profileId} disabled={disabledIf(busy)} className={item.profileId === profileId ? styles.selectedProfile : styles.profileButton} onClick={() => chooseProfile(item)}>{item.widthMm} × {item.heightMm} mm · {item.calibrated ? '已校准' : '待校准'}</Button>)}
      <View className={styles.mediaGrid}>{([{ key: 'widthMm', title: '实测宽度（mm）' }, { key: 'heightMm', title: '实测高度（mm）' }, { key: 'density', title: '浓度（1–5）' }, { key: 'top', title: '上边距（mm）' }, { key: 'right', title: '右边距（mm）' }, { key: 'bottom', title: '下边距（mm）' }, { key: 'left', title: '左边距（mm）' }] as const).map(field => <View className={styles.inputField} key={field.key}><Text>{field.title}</Text><Input ariaLabel={field.title} type='digit' value={media[field.key]} placeholder='请输入' disabled={disabledIf(!printer.supported || busy)} onInput={event => setMedia(value => ({ ...value, [field.key]: event.detail.value }))} /></View>)}</View>
      <View className={styles.actions}><Button className={styles.secondary} disabled={disabledIf(!printer.supported || busy)} onClick={saveMedia}>保存纸张配置</Button><Button className={styles.secondary} disabled={disabledIf(busy)} onClick={calibrate}>打印校准样张</Button><Button className={styles.smallButton} disabled={disabledIf(Boolean(operation) || cancelling)} onClick={confirmCalibration}>已核对校准实物</Button></View>
      {actionError && <Text id='calibration-action-error' className={styles.error} aria-live='assertive'>{actionError}</Text>}
    </View>}
    <View className={styles.tabs}><Button className={kind === 'finished-product' ? styles.activeTab : styles.tab} disabled={disabledIf(busy)} onClick={() => switchKind('finished-product')}>成品标签</Button><Button className={kind === 'paperboard-batch' ? styles.activeTab : styles.tab} disabled={disabledIf(busy)} onClick={() => switchKind('paperboard-batch')}>纸板批次标签</Button></View>
    <View className={styles.columns}><View className={styles.card}>
      <Text className={styles.sectionTitle}>1 · 选择{kind === 'finished-product' ? '商品' : '纸板批次'}</Text>
      <Input ariaLabel='搜索记录' className={styles.search} value={query} disabled={disabledIf(busy)} placeholder={kind === 'finished-product' ? '搜索商品名称或规格' : '搜索批次号、板厂或纸板规格'} onInput={event => { setQuery(event.detail.value); setPage(1); }} />
      {loading ? <Text className={styles.empty}>正在查询…</Text> : listError ? <View className={styles.empty}><Text>{listError}</Text><Button className={styles.smallButton} onClick={() => setReload(value => value + 1)}>重新查询</Button></View> : !results.length ? <View className={styles.empty}><Text>{total === 0 && !query.trim() ? `当前共享仓库还没有${kind === 'finished-product' ? '商品' : '纸板批次'}记录。` : '没有找到匹配记录，请换一个关键词。'}</Text>{total === 0 && !query.trim() && <Button className={styles.secondary} onClick={() => void Taro.navigateTo({ url: kind === 'finished-product' ? '/pages/management/index?section=goods' : '/pages/management/index?section=paperboard-receipt' })}>{kind === 'finished-product' ? '前往商品管理' : '新增纸板批次'}</Button>}</View> : results.map(item => <Button key={idOf(item)} className={selected && idOf(selected) === idOf(item) && selected.kind === item.kind ? styles.selectedRecord : styles.record} disabled={disabledIf(busy)} onClick={() => void selectRecord(item.kind, idOf(item))}>{item.kind === 'finished-product' ? <><Text className={styles.recordTitle}>{item.data.name}</Text><Text className={styles.meta}>{item.data.specification || `${item.data.length || '—'} × ${item.data.width || '—'} mm`} · ID {item.data.id}</Text><Text className={styles.meta}>当前库存 {item.data.stock} {item.data.unit || '（单位未填写）'}</Text></> : <><Text className={styles.recordTitle}>{item.data.boardLength} × {item.data.boardWidth} cm · {item.data.fluteType}</Text><Text className={styles.meta}>{item.data.id}</Text><Text className={styles.meta}>{item.data.supplier} · {item.data.location || '未填库位'} · 当前余量 {item.data.remainingQty} 张</Text></>}</Button>)}
      <View className={styles.pagination}><Button className={styles.smallButton} disabled={disabledIf(busy || loading || page <= 1)} onClick={() => setPage(value => value - 1)}>上一页</Button><Text>{page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} · 共 {total} 条</Text><Button className={styles.smallButton} disabled={disabledIf(busy || loading || page * PAGE_SIZE >= total)} onClick={() => setPage(value => value + 1)}>下一页</Button></View>
    </View><View className={styles.card}>
      <Text className={styles.sectionTitle}>2 · 核对打印字段</Text>
      {!selected ? <Text className={styles.empty}>先选择一条记录，再核对字段。</Text> : <><Text className={styles.meta}>必需识别字段始终保留。可选字段默认关闭；库存和余量是打印时快照。</Text><View className={styles.fieldOptions}>{(kind === 'finished-product' ? productOptions : boardOptions).map(option => <Button key={option.key} disabled={disabledIf(busy)} className={optionState[option.key] ? styles.optionOn : styles.option} onClick={() => { if (kind === 'finished-product') { setFinishedOptions(value => ({ ...value, [option.key]: !value[option.key] })); if (option.key === 'printedAt') setFrozenAt(new Date().toISOString()); } else setBoardFields(value => ({ ...value, [option.key]: !value[option.key] })); }}>{optionState[option.key] ? '✓ ' : '+ '}{option.title}</Button>)}</View>{built.error && <Text className={styles.error}>{built.error}</Text>}{built.data && <View className={styles.fieldList}><View className={styles.fieldRow}><Text>标签类型</Text><Text>{kind === 'finished-product' ? '成品' : '纸板批次'}</Text></View>{Object.entries(built.data).filter(([key]) => !['productUrl', 'batchUrl', 'unit'].includes(key)).map(([key, value]) => <View className={styles.fieldRow} key={key}><Text>{names[key] || key}</Text><Text>{fieldValue(key, value, built.data!)}</Text></View>)}<View className={styles.fieldRow}><Text>二维码</Text><Text>系统生成的只读详情链接</Text></View></View>}</>}
      <Text className={styles.sectionTitle}>3 · SDK 实际预览</Text>
      {!printer.supported ? <View className={styles.previewEmpty}>此平台无法生成官方 SDK 预览。上方为字段清单，不代表实际打印版面；请在新版 iOS App 中继续。</View> : !profile ? <View className={styles.previewEmpty}>请连接打印机并保存实际纸张尺寸后生成 SDK 预览。</View> : previewLoading ? <View className={styles.previewEmpty}>正在生成官方 SDK 预览…</View> : previewError ? <View className={styles.error}>{previewError}。请核对字段，必要时关闭可选字段。</View> : preview ? <><Image className={styles.previewImage} src={preview.image} mode='widthFix' /><Text className={styles.meta}>此图由官方 SDK 生成，打印使用同一份数据与模板。</Text>{preview.warnings.map(warning => <Text className={styles.error} key={warning}>{warning}</Text>)}</> : <View className={styles.previewEmpty}>选择有效记录后显示 SDK 预览。</View>}
      <View className={styles.copies}><Text>打印份数</Text><Input ariaLabel='打印份数' type='number' value={copies} disabled={disabledIf(busy)} onInput={event => setCopies(event.detail.value)} /><Text className={styles.meta}>当前验收上限 {maxCopies} 份</Text></View>
      {!copiesValid && <Text className={styles.error}>请输入 1–{maxCopies} 之间的整数份数。</Text>}
      {refreshRequired && <View className={styles.errorBox}><Text>最新资料尚未校验成功，暂不能打印。原预览仅供核对。</Text><Button className={styles.secondary} disabled={disabledIf(busy)} onClick={recheckRecord}>重新在线校验资料</Button></View>}
      <Button className={styles.primary} disabled={disabledIf(Boolean(printDisabled))} onClick={submit}>{operation || (printer.productionEnabled ? '核对最新资料并打印' : '正式打印等待 K3 验收')}</Button>
      {printer.supported && !profile?.calibrated && <Text className={styles.meta}>请先完成纸张配置和校准实物确认。</Text>}
    </View></View>
    {job && <View className={styles.card}><Text className={styles.sectionTitle}>当前任务 · {phases[job.phase] || job.phase}</Text><Text className={styles.jobId}>{job.jobId}</Text>{job.message && <Text className={styles.meta}>{job.message}</Text>}{job.errorCode && <Text className={styles.error}>错误码：{job.errorCode}</Text>}{job.outcomeConfidence === 'count-verified' && Number.isFinite(job.printed) && <Text>已确认进度 {job.printed}/{job.total}</Text>}{job.phase === 'uncertain' && <Text className={styles.error}>可能已经出纸。请先查看实体标签，不会自动重试；需要重印时请重新选择记录并核对预览。</Text>}{isActivePrintJob(job) && <Button className={styles.secondary} disabled={disabledIf(cancelling)} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消当前任务'}</Button>}</View>}
    {recent.length > 0 && <View className={styles.card}><Text className={styles.sectionTitle}>最近本机任务</Text><Text className={styles.meta}>仅保留最近 10 条轻量记录，不保存标签图像；清除 App 数据会丢失记录。</Text>{recent.map(item => <View className={styles.historyRow} key={item.jobId}><Text>{phases[item.phase] || item.phase} · {item.total} 份</Text><Text className={styles.jobId}>{item.jobId}</Text></View>)}</View>}
  </View>;
}

type LabelTransport = 'computer' | 'bluetooth';

export default function LabelPrintPage() {
  // Remote USB is the normal path: the phone must not need a Bluetooth
  // connection for every label. Native Bluetooth stays available explicitly.
  const [transport, setTransport] = useState<LabelTransport>('computer');
  if (transport === 'bluetooth') return <NativeLabelPrintPage onComputer={() => setTransport('computer')} />;
  return <RemoteLabelPrintPage onBluetooth={() => setTransport('bluetooth')} />;
}
