/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getProductsPage } from '@/services/api';
import { getBoards } from '@/services/boards';
import type { BoardBatch } from '@/services/boards';
import type { Product } from '@/types';
import {
  buildBoardLabelSnapshot, buildFinishedLabelSnapshot, changedSnapshotFields,
  fetchLatestLabelRecord
} from '@/features/label-print';
import type { BoardLabelOptions, FinishedLabelOptions, LabelKind, LabelSnapshot } from '@/features/label-print';
import { buildRemoteLabelHtml } from '@/features/label-print/remote-layout';
import type { MediaProfile } from '@/features/label-print/native';
import {
  confirmRemoteLabelCalibration, getRemoteLabelDevice, getRemoteLabelJob, newRemoteLabelJobId,
  readRemoteLabelAttempt, remoteLabelErrorMessage, resolveRemoteLabelJob, saveRemoteLabelAttempt,
  saveRemoteLabelProfile, submitRemoteLabelJob
} from '@/services/remote-label-print';
import type {
  RemoteLabelAttempt, RemoteLabelDevice, RemoteLabelJob, RemoteLabelJobInput
} from '@/services/remote-label-print';
import { cleanPrintPairFromAddress, parsePrintPairToken, readPrintPair, readPrintPairFromAddress, savePrintPair } from '@/services/remote-print';
import { scanPrintPairQr } from '@/services/print-pair-scan';
import styles from './remote.module.scss';

type RecordChoice = { kind: 'finished-product'; data: Product } | { kind: 'paperboard-batch'; data: BoardBatch };
type FieldOption = { key: string; title: string };
const productOptions: FieldOption[] = [
  { key: 'material', title: '材质' }, { key: 'corrugation', title: '楞型' },
  { key: 'layers', title: '层数' }, { key: 'weight', title: '克重' },
  { key: 'printedAt', title: '打印日期' }, { key: 'stockSnapshot', title: '打印时库存' }
];
const boardOptions: FieldOption[] = [
  { key: 'layers', title: '层数' }, { key: 'faceGsm', title: '面纸克重' },
  { key: 'linerGsm', title: '里纸克重' }, { key: 'flutingGsm', title: '楞纸克重' },
  { key: 'cartonDimensions', title: '纸箱尺寸' }, { key: 'receivedDate', title: '入库日期' },
  { key: 'location', title: '库位' }, { key: 'receivedQty', title: '实收数量' },
  { key: 'remainingQtySnapshot', title: '打印时余量' }
];
const fieldNames: Record<string, string> = {
  customerName: '客户', printPlate: '印刷版名', printColor: '颜色',
  name: '商品名称', specification: '规格', unit: '库存单位', productId: '商品 ID', batchId: '批次号',
  boardLength: '纸板长', boardWidth: '纸板宽', fluteType: '楞型', supplier: '板厂', material: '材质',
  corrugation: '楞型', layers: '层数', weight: '克重', stockSnapshot: '打印时库存', printedAt: '打印日期',
  faceGsm: '面纸克重', linerGsm: '里纸克重', flutingGsm: '楞纸克重',
  cartonLength: '纸箱长', cartonWidth: '纸箱宽', cartonHeight: '纸箱高', receivedDate: '入库日期',
  location: '库位', receivedQty: '实收数量', remainingQtySnapshot: '打印时余量'
};
const PAGE_SIZE = 12;
const defaultMedia = { widthMm: '70', heightMm: '100', top: '0.6', right: '0.5', bottom: '0.5', left: '0.5' };
const disabledIf = (condition: boolean) => condition ? true : undefined;
const idOf = (record: RecordChoice) => String(record.data.id);
const statusNames: Record<string, string> = {
  waiting: '等待打印电脑接收', processing: '电脑正在通过 USB 发送', queued: '出纸已确认',
  failed: '打印任务失败', uncertain: '打印结果待确认', expired: '任务已过期'
};
const cleanTimestamp = (value?: string | number) => {
  if (value === undefined) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
};
const fnv1a = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const profileSignature = (profile: Pick<MediaProfile, 'printerName' | 'widthMm' | 'heightMm' | 'density' | 'marginMm'>) =>
  JSON.stringify({ printerName: profile.printerName, widthMm: profile.widthMm, heightMm: profile.heightMm, density: profile.density, marginMm: profile.marginMm, paperStyle: 'gap' });
const profileIdFor = (deviceId: string, profile: Pick<MediaProfile, 'printerName' | 'widthMm' | 'heightMm' | 'density' | 'marginMm'>) =>
  `remote-${fnv1a(`${deviceId}:${profileSignature(profile)}`)}`;
const densityFor = (kind: LabelKind, widthMm: number, heightMm: number) =>
  kind === 'paperboard-batch' && Math.abs(widthMm - 70) < 0.001 && Math.abs(heightMm - 100) < 0.001 ? 4 : 3;
const profileMatchesKind = (kind: LabelKind, profile: MediaProfile) =>
  profile.density === densityFor(kind, profile.widthMm, profile.heightMm);
const asProfile = (device: RemoteLabelDevice, values: typeof defaultMedia, kind: LabelKind): MediaProfile => {
  const widthMm = Number(values.widthMm.trim());
  const heightMm = Number(values.heightMm.trim());
  const marginMm = {
    top: Number(values.top.trim()), right: Number(values.right.trim()),
    bottom: Number(values.bottom.trim()), left: Number(values.left.trim())
  };
  const profile = {
    profileId: '', printerName: device.printer, widthMm, heightMm, paperStyle: 'gap' as const,
    density: densityFor(kind, widthMm, heightMm), marginMm, calibrated: false
  };
  profile.profileId = profileIdFor(device.id, profile);
  return profile;
};
function snapshotOf(record: RecordChoice, finished: FinishedLabelOptions, board: BoardLabelOptions, at: string): LabelSnapshot {
  return record.kind === 'finished-product' ? buildFinishedLabelSnapshot(record.data, finished, at) : buildBoardLabelSnapshot(record.data, board);
}
function valueText(key: string, value: unknown, data: LabelSnapshot): string {
  if (['boardLength', 'boardWidth', 'cartonLength', 'cartonWidth', 'cartonHeight'].includes(key)) return `${value} cm`;
  if (['weight', 'faceGsm', 'linerGsm', 'flutingGsm'].includes(key)) return `${value} g/m²`;
  if (['receivedQty', 'remainingQtySnapshot'].includes(key)) return `${value} 张`;
  if (key === 'stockSnapshot' && 'unit' in data) return `${value} ${data.unit}`;
  if (key === 'printedAt') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false });
  return String(value);
}
function attemptFor(input: RemoteLabelJobInput, device: RemoteLabelDevice, profile: MediaProfile): RemoteLabelAttempt {
  const fingerprint = fnv1a(JSON.stringify({
    deviceId: device.id, printer: device.printer, profileId: profile.profileId,
    profile: profileSignature(profile), kind: input.kind, copies: input.copies, data: input.data
  }));
  return {
    id: newRemoteLabelJobId(), fingerprint, deviceId: device.id, printer: device.printer,
    profileId: profile.profileId, kind: input.kind, copies: input.copies, data: input.data, startedAt: Date.now()
  };
}

export default function RemoteLabelPrintPage({ onBluetooth }: { onBluetooth: () => void }) {
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
  const [boardFields, setBoardFields] = useState<BoardLabelOptions>({ receivedDate: true, receivedQty: true });
  const [frozenAt, setFrozenAt] = useState(() => new Date().toISOString());
  const [token, setToken] = useState(readPrintPair);
  const [pairError, setPairError] = useState('');
  const [device, setDevice] = useState<RemoteLabelDevice>();
  const [deviceError, setDeviceError] = useState('');
  const [profileId, setProfileId] = useState('');
  const [media, setMedia] = useState(defaultMedia);
  const [copies, setCopies] = useState('1');
  const [attempt, setAttempt] = useState<RemoteLabelAttempt | null>(readRemoteLabelAttempt);
  const [job, setJob] = useState<RemoteLabelJob>();
  const [jobError, setJobError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState('');
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFits, setPreviewFits] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const actionLock = useRef(false);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const listGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const linkedPair = useRef(readPrintPairFromAddress());
  const hadPairLink = useRef(typeof window !== 'undefined' && window.location.href.includes('print_pair='));
  const pairLinkHandled = useRef(false);
  const currentProfile = useMemo(() => device?.profiles.find(item =>
    item.profileId === profileId && item.printerName === device.printer && profileMatchesKind(kind, item)), [device, profileId, kind]);
  const largeBoardTemplate = Boolean(currentProfile &&
    densityFor('paperboard-batch', currentProfile.widthMm, currentProfile.heightMm) === 4);
  const effectiveBoardFields = useMemo<BoardLabelOptions>(() => largeBoardTemplate
    ? { receivedDate: boardFields.receivedDate, receivedQty: boardFields.receivedQty, remainingQtySnapshot: boardFields.remainingQtySnapshot }
    : boardFields, [boardFields, largeBoardTemplate]);
  const visibleBoardOptions = largeBoardTemplate
    ? boardOptions.filter(option => ['receivedDate', 'receivedQty', 'remainingQtySnapshot'].includes(option.key))
    : boardOptions;
  const built = useMemo(() => {
    if (!selected) return { data: null, error: '' };
    try { return { data: snapshotOf(selected, finishedOptions, effectiveBoardFields, frozenAt), error: '' }; }
    catch (issue) { return { data: null, error: remoteLabelErrorMessage(issue) }; }
  }, [selected, finishedOptions, effectiveBoardFields, frozenAt]);
  const copyCount = Number(copies);
  const maxCopies = Math.max(1, Math.min(99, Math.floor(device?.maxCopies || 99)));
  const copiesValid = /^\d+$/.test(copies) && Number.isSafeInteger(copyCount) && copyCount >= 1 && copyCount <= maxCopies;
  const pending = Boolean(job && ['waiting', 'processing', 'uncertain'].includes(job.status));
  const deviceForAttempt = !attempt || !device || attempt.deviceId === device.id;
  const busy = Boolean(action || (pending && deviceForAttempt));

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; listGeneration.current += 1; previewGeneration.current += 1; };
  }, []);

  useEffect(() => {
    if (!token) { setDevice(undefined); setDeviceError(''); return undefined; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getRemoteLabelDevice(token);
        if (!active || !alive.current) return;
        setDevice(next);
        setDeviceError('');
        const availableProfiles = next.profiles.filter(item => item.printerName === next.printer && profileMatchesKind(kind, item));
        const previouslySelected = availableProfiles.find(item => item.profileId === profileId);
        const selectedProfile = previouslySelected || availableProfiles.find(item =>
          kind !== 'paperboard-batch' || (item.widthMm === 70 && item.heightMm === 100));
        setProfileId(selectedProfile?.profileId || '');
        if (selectedProfile && !previouslySelected) {
          setMedia({
            widthMm: String(selectedProfile.widthMm), heightMm: String(selectedProfile.heightMm),
            top: String(selectedProfile.marginMm.top), right: String(selectedProfile.marginMm.right),
            bottom: String(selectedProfile.marginMm.bottom), left: String(selectedProfile.marginMm.left)
          });
        }
        setNotice('');
      } catch (issue) {
        if (active && alive.current) {
          const statusCode = (issue as { statusCode?: number })?.statusCode;
          setDeviceError(statusCode === 401 || statusCode === 403
            ? '打印电脑配对已失效，请重新输入新的配对码。'
            : remoteLabelErrorMessage(issue));
        }
      } finally {
        if (active && alive.current) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [token, refresh, profileId, kind]);

  useEffect(() => {
    const id = router.params.id;
    if (id) void selectRecord(router.params.kind === 'paperboard-batch' ? 'paperboard-batch' : 'finished-product', id);
    // Route shortcuts are consumed once on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const generation = ++listGeneration.current;
    setLoading(true);
    setListError('');
    const timer = setTimeout(() => {
      const search = query.trim();
      const load = async () => {
        if (kind === 'finished-product') {
          const result = await getProductsPage({ page, page_size: PAGE_SIZE, keyword: search, sort: 'name', order: 'asc' });
          return {
            items: result.items.filter(item => !item.deleted_at).map(data => ({ kind: 'finished-product' as const, data })),
            total: result.total
          };
        }
        const batches = await getBoards();
        const filtered = batches.filter(batch => !search ||
          [batch.id, batch.customerName, batch.material, batch.printPlate, batch.printColor, batch.supplier, batch.fluteType, `${batch.boardLength}×${batch.boardWidth}`,
            `${batch.boardLength} × ${batch.boardWidth}`, batch.location].join(' ').toLowerCase().includes(search.toLowerCase()));
        return {
          items: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(data => ({ kind: 'paperboard-batch' as const, data })),
          total: filtered.length
        };
      };
      void load().then(value => {
        if (alive.current && generation === listGeneration.current) { setResults(value.items); setTotal(value.total); }
      }).catch(issue => {
        if (alive.current && generation === listGeneration.current) { setResults([]); setListError(remoteLabelErrorMessage(issue)); }
      }).finally(() => {
        if (alive.current && generation === listGeneration.current) setLoading(false);
      });
    }, 250);
    return () => { clearTimeout(timer); listGeneration.current += 1; };
  }, [kind, query, page, reload]);

  const selectRecord = useCallback(async (nextKind: LabelKind, id: string) => {
    if (busy) return;
    setError('');
    setNotice('正在读取最新资料…');
    setSelected(null);
    try {
      const data = await fetchLatestLabelRecord(nextKind, id);
      if (!alive.current) return;
      setKind(nextKind);
      setSelected(nextKind === 'finished-product'
        ? { kind: 'finished-product', data: data as Product }
        : { kind: 'paperboard-batch', data: data as BoardBatch });
      setFrozenAt(new Date().toISOString());
      setNotice('');
    } catch (issue) {
      if (alive.current) { setError(remoteLabelErrorMessage(issue)); setNotice(''); }
    }
  }, [busy]);

  useEffect(() => {
    if (!attempt || !token || !device || attempt.deviceId !== device.id || action) {
      setJob(undefined);
      setNotFound(false);
      return undefined;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let complete = false;
      try {
        const result = await getRemoteLabelJob(attempt.id, token);
        if (active && alive.current) {
          setJob(result);
          setJobError('');
          setNotFound(false);
        }
        complete = ['queued', 'failed', 'expired'].includes(result.status);
      } catch (issue) {
        const statusCode = (issue as { statusCode?: number })?.statusCode;
        if (active && alive.current) {
          setNotFound(statusCode === 404);
          setJobError(statusCode === 404
            ? '服务器尚未收到该任务；未自动重发。确认后可沿用原任务编号重新查询/发送。'
            : remoteLabelErrorMessage(issue));
        }
      } finally {
        if (active && alive.current && !complete) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
    // Binding follows only this attempt, pairing token, and target device.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, token, device?.id, refresh, action]);

  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden') setRefresh(value => value + 1); };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  const previewKey = built.data && currentProfile
    ? JSON.stringify({ kind, data: built.data, profile: currentProfile, copies: copyCount })
    : '';
  useEffect(() => {
    const generation = ++previewGeneration.current;
    setPreview('');
    setPreviewFits(false);
    setPreviewWarnings([]);
    setPreviewError('');
    if (!built.data || !currentProfile || !copiesValid) { setPreviewLoading(false); return undefined; }
    setPreviewLoading(true);
    void buildRemoteLabelHtml({
      kind, profile: currentProfile, copies: copyCount, data: built.data
    }).then(result => {
      if (!alive.current || generation !== previewGeneration.current) return;
      setPreview(result.html);
      setPreviewWarnings(result.warnings || []);
    }).catch(issue => {
      if (alive.current && generation === previewGeneration.current) setPreviewError(remoteLabelErrorMessage(issue));
    }).finally(() => {
      if (alive.current && generation === previewGeneration.current) setPreviewLoading(false);
    });
    return () => { previewGeneration.current += 1; };
    // previewKey serializes all label data and profile inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, copiesValid]);

  const checkFrameGeometry = useCallback(async () => {
    const document = frame.current?.contentDocument;
    await document?.fonts.ready;
    if (document !== frame.current?.contentDocument) return;
    const labelPage = document?.querySelector<HTMLElement>('.warehouse-label');
    const body = document?.querySelector<HTMLElement>('.label-body, .paperboard-label');
    if (!labelPage || !body || !currentProfile) { setPreviewFits(false); return; }
    labelPage.style.transform = 'none';
    const pageBox = labelPage.getBoundingClientRect();
    const expectedRatio = currentProfile.widthMm / currentProfile.heightMm;
    const actualRatio = pageBox.width / Math.max(1, pageBox.height);
    const tolerance = Math.max(2, pageBox.width * 0.025);
    const fieldsFit = Array.from(document!.querySelectorAll<HTMLElement>('[data-fit]')).every(element => {
      const maxHeight = parseFloat(document!.defaultView!.getComputedStyle(element).maxHeight);
      const verticalOverflow = element.classList.contains('paperboard-value')
        ? Number.isFinite(maxHeight) && element.scrollHeight > maxHeight + 2
        : element.scrollHeight > element.clientHeight + 2;
      return element.scrollWidth <= element.clientWidth + 2 && !verticalOverflow;
    });
    const fits = fieldsFit && Math.abs(actualRatio - expectedRatio) <= 0.04 &&
      labelPage.scrollWidth <= labelPage.clientWidth + 2 && labelPage.scrollHeight <= labelPage.clientHeight + 2 &&
      body.scrollWidth <= body.clientWidth + 2 && body.scrollHeight <= body.clientHeight + 2 &&
      body.getBoundingClientRect().right <= labelPage.getBoundingClientRect().right + tolerance &&
      body.getBoundingClientRect().bottom <= labelPage.getBoundingClientRect().bottom + tolerance;
    const scale = frame.current ? frame.current.clientWidth / Math.max(1, pageBox.width) : 1;
    labelPage.style.transformOrigin = 'top left';
    labelPage.style.transform = `scale(${scale})`;
    setPreviewFits(fits);
  }, [currentProfile]);
  useEffect(() => {
    const resize = () => { void checkFrameGeometry(); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [checkFrameGeometry]);

  const pair = useCallback(async (raw?: string) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setAction('正在验证连接…');
    setPairError('');
    try {
      const scanned = raw === undefined ? await scanPrintPairQr() : raw;
      if (!scanned) return;
      const candidate = parsePrintPairToken(scanned);
      if (!candidate) throw new Error('没有识别到有效的打印连接二维码，请重新扫码或打开连接链接');
      const result = await getRemoteLabelDevice(candidate);
      if (!alive.current) return;
      cleanPrintPairFromAddress();
      savePrintPair(candidate);
      setToken(candidate);
      setDevice(result);
      setPairError('');
    } catch (issue) {
      if (alive.current) setPairError(remoteLabelErrorMessage(issue));
    } finally {
      actionLock.current = false;
      if (alive.current) setAction('');
    }
  }, []);

  useEffect(() => {
    if (pairLinkHandled.current) return;
    pairLinkHandled.current = true;
    if (linkedPair.current) void pair(linkedPair.current);
    else if (hadPairLink.current) setPairError('打印连接链接无效，请重新扫描电脑上的二维码');
  }, [pair]);

  const validateMedia = () => {
    const fields = Object.values(media).map(value => value.trim());
    if (fields.some(value => !value || !Number.isFinite(Number(value)))) throw new Error('请填写实测标签宽高和四边距');
    const profile = asProfile(device!, media, kind);
    if (profile.widthMm < 20 || profile.widthMm > 120 || profile.heightMm < 20 || profile.heightMm > 200 ||
      Object.values(profile.marginMm).some(value => value < 0.5 || value > 30) ||
      profile.marginMm.left + profile.marginMm.right >= profile.widthMm ||
      profile.marginMm.top + profile.marginMm.bottom >= profile.heightMm) {
      throw new Error('宽度须为 20–120 mm、高度 20–200 mm；每边距 0.5–30 mm，且两侧边距之和须小于纸张尺寸');
    }
    return profile;
  };

  const saveProfile = async () => {
    if (actionLock.current || !device) return;
    actionLock.current = true;
    setAction('正在保存纸张配置…');
    setError('');
    try {
      const profile = validateMedia();
      const saved = await saveRemoteLabelProfile(profile, token);
      if (!alive.current) return;
      const next = { ...profile, ...saved, printerName: device.printer };
      setDevice(value => value ? {
        ...value, profiles: [...value.profiles.filter(item => item.profileId !== next.profileId), next]
      } : value);
      setProfileId(next.profileId);
      setNotice(`已保存 ${next.widthMm} × ${next.heightMm} mm 纸张配置，浓度 ${next.density}。`);
    } catch (issue) {
      if (alive.current) setError(remoteLabelErrorMessage(issue));
    } finally {
      actionLock.current = false;
      if (alive.current) setAction('');
    }
  };

  const startJob = async (input: RemoteLabelJobInput, reusedAttempt?: RemoteLabelAttempt) => {
    if (actionLock.current || !device || !currentProfile) return;
    actionLock.current = true;
    setAction(input.kind === 'calibration' ? '正在发送校准样张…' : '正在发送标签…');
    setError('');
    setJobError('');
    setNotFound(false);
    const nextAttempt = reusedAttempt || attemptFor(input, device, currentProfile);
    saveRemoteLabelAttempt(nextAttempt);
    setAttempt(nextAttempt);
    try {
      const result = await submitRemoteLabelJob({
        ...input, id: nextAttempt.id, profileId: nextAttempt.profileId
      }, token);
      if (alive.current) { setJob(result); setNotice(''); }
    } catch (issue) {
      if ((issue as { statusCode?: number })?.statusCode === 409 && input.kind !== 'calibration' && !reusedAttempt) {
        saveRemoteLabelAttempt(attempt);
        if (alive.current) {
          setAttempt(attempt);
          setJob(job);
          setJobError('');
          setError(remoteLabelErrorMessage(issue));
          setNotice('');
        }
        return { conflict: issue };
      }
      if (alive.current) {
        setJobError(remoteLabelErrorMessage(issue));
        setNotice('发送结果尚未确认，正在查询原任务；不会自动重复提交。');
      }
    } finally {
      actionLock.current = false;
      if (alive.current) setAction('');
    }
  };

  const calibrate = () => {
    if (!device || !currentProfile || pending || deviceError || !device.online || !device.ready) {
      setError('请确认打印电脑在线、K3 已就绪并选择纸张配置');
      return;
    }
    if (currentProfile.calibrated) { setNotice('该纸张配置已完成实物校准。需要重新校准时，请修改纸张尺寸或边距后保存新配置。'); return; }
    const input: RemoteLabelJobInput = { id: '', kind: 'calibration', profileId: currentProfile.profileId, copies: 1 };
    void startJob(input);
  };

  const confirmCalibration = async () => {
    if (!job || job.kind !== 'calibration' || job.status !== 'queued' || !currentProfile || actionLock.current) return;
    actionLock.current = true;
    setAction('正在确认校准…');
    setError('');
    try {
      const saved = await confirmRemoteLabelCalibration(currentProfile.profileId, job.id, token);
      if (!alive.current) return;
      setDevice(value => value ? {
        ...value,
        profiles: value.profiles.map(item => item.profileId === currentProfile.profileId
          ? { ...item, ...saved, calibrated: true } : item)
      } : value);
      setNotice('已确认校准样张实物。以后普通标签由打印机串口回执确认出纸后自动完成。');
    } catch (issue) {
      if (alive.current) setError(remoteLabelErrorMessage(issue));
    } finally {
      actionLock.current = false;
      if (alive.current) setAction('');
    }
  };

  const resolveJob = async (outcome: 'printed' | 'missing') => {
    if (!job || job.status !== 'uncertain' || actionLock.current) return;
    actionLock.current = true;
    setAction(outcome === 'printed' ? '正在确认已出纸…' : '正在记录未出纸…');
    setError('');
    try {
      const result = await resolveRemoteLabelJob(job.id, outcome, token);
      if (alive.current) setJob(result);
    } catch (issue) {
      if (alive.current) setError(remoteLabelErrorMessage(issue));
    } finally {
      actionLock.current = false;
      if (alive.current) setAction('');
    }
  };

  const retryJob = () => {
    if (!device || !currentProfile || !job || !['failed', 'expired'].includes(job.status) || busy) return;
    if (job.kind === 'calibration') {
      void startJob({ id: '', kind: 'calibration', profileId: currentProfile.profileId, copies: 1 });
      return;
    }
    if (!built.data || !copiesValid) { setError('请重新选择标签记录并核对份数后重试'); return; }
    void startJob({ id: '', kind, profileId: currentProfile.profileId, copies: copyCount, data: built.data });
  };

  const resumeMissingJob = () => {
    if (!attempt || !device || !currentProfile || !notFound || pending || busy) return;
    const input: RemoteLabelJobInput = {
      id: attempt.id, kind: attempt.kind, profileId: attempt.profileId, copies: attempt.copies,
      ...(attempt.kind === 'calibration' || !attempt.data ? {} : { data: attempt.data })
    };
    void startJob(input, attempt);
  };

  const submit = async () => {
    if (!selected || !built.data || !device || !currentProfile || !copiesValid || !previewFits ||
      previewWarnings.length || busy || pending || !device.online || !device.ready || deviceError) return;
    const expected = built.data;
    setError('');
    setNotice('正在复核最新商品或批次资料…');
    try {
      const latest = await fetchLatestLabelRecord(kind, idOf(selected));
      const freshChoice: RecordChoice = selected.kind === 'finished-product'
        ? { kind: 'finished-product', data: latest as Product }
        : { kind: 'paperboard-batch', data: latest as BoardBatch };
      const fresh = snapshotOf(freshChoice, finishedOptions, effectiveBoardFields, frozenAt);
      const changed = changedSnapshotFields(expected, fresh);
      if (changed.length) {
        setSelected(freshChoice);
        setFrozenAt(new Date().toISOString());
        setNotice(`资料已更新（${changed.map(key => fieldNames[key] || key).join('、')}）。预览已刷新，请重新核对后再打印。`);
        return;
      }
      setNotice('');
      const result = await startJob({ id: '', kind, profileId: currentProfile.profileId, copies: copyCount, data: expected });
      if (result?.conflict) throw result.conflict;
    } catch (issue) {
      const statusCode = (issue as { statusCode?: number })?.statusCode;
      if (alive.current && statusCode === 409) {
        try {
          const latest = await fetchLatestLabelRecord(kind, idOf(selected));
          const freshChoice: RecordChoice = selected.kind === 'finished-product'
            ? { kind: 'finished-product', data: latest as Product }
            : { kind: 'paperboard-batch', data: latest as BoardBatch };
          const fresh = snapshotOf(freshChoice, finishedOptions, effectiveBoardFields, frozenAt);
          const changed = changedSnapshotFields(expected, fresh);
          if (changed.length) {
            setSelected(freshChoice);
            setFrozenAt(new Date().toISOString());
            setError('');
            setNotice(`服务器发现资料已更新（${changed.map(key => fieldNames[key] || key).join('、')}）。预览已刷新，请重新核对后再打印。`);
            return;
          }
        } catch { /* Preserve the original server validation error below. */ }
      }
      if (alive.current) {
        setError(remoteLabelErrorMessage(issue));
        setNotice('最新资料未能复核成功，未提交打印任务。');
      }
    }
  };

  const chooseProfile = (profile: MediaProfile) => {
    if (busy) return;
    setProfileId(profile.profileId);
    setMedia({
      widthMm: String(profile.widthMm), heightMm: String(profile.heightMm),
      top: String(profile.marginMm.top), right: String(profile.marginMm.right),
      bottom: String(profile.marginMm.bottom), left: String(profile.marginMm.left)
    });
  };
  const switchKind = (next: LabelKind) => {
    if (busy || next === kind) return;
    setKind(next); setSelected(null); setQuery(''); setPage(1); setNotice(''); setError('');
    setProfileId(''); setMedia(defaultMedia);
  };

  const profileInput = (() => {
    try { return device ? validateMedia() : undefined; } catch { return undefined; }
  })();
  const configuredProfile = currentProfile && profileInput &&
    profileSignature(currentProfile) === profileSignature(profileInput);
  const configuredDensity = densityFor(kind, Number(media.widthMm), Number(media.heightMm));
  const deviceState = !token ? '未连接打印电脑'
    : deviceError ? '打印电脑连接待确认'
      : !device ? '正在连接打印电脑'
        : !device.online ? '打印电脑离线'
          : !device.ready ? 'K3 暂不可用'
            : `在线 · ${device.printer}`;
  const jobIsCurrentCalibration = job?.kind === 'calibration' && attempt?.profileId === currentProfile?.profileId;
  const needsCalibration = Boolean(currentProfile && !currentProfile.calibrated);
  const canSubmit = Boolean(selected && built.data && currentProfile?.calibrated && device?.online && device.ready &&
    !deviceError && !pending && !busy && configuredProfile && copiesValid && preview && previewFits && !previewWarnings.length);
  const optionState = kind === 'finished-product' ? finishedOptions : boardFields;

  return <View className={styles.page}>
    <nav className={styles.printModes} aria-label='打印类型'>
      <button type='button' aria-pressed='false' onClick={() => void Taro.switchTab({ url: '/pages/print-center/index' })}>送货单</button>
      <button type='button' aria-pressed='true'>标签打印</button>
    </nav>
    <View className={styles.topBar}>
      <View className={styles.titleBlock}>
        <Text className={styles.eyebrow}>仓库 · 标签</Text>
        <Text className={styles.title}>电脑 USB 打印 K3</Text>
        <Text className={styles.subtitle}>手机经互联网发送到店里电脑，再由 USB K3 打印；手机不连接蓝牙。送货单 630K 通道保持独立。</Text>
      </View>
      <Button className={styles.switchButton} onClick={onBluetooth}>切换手机蓝牙打印</Button>
    </View>

    <View className={styles.deviceBar}>
      <View className={styles.deviceInfo}>
        <Text className={styles.deviceStatus}>{deviceState}</Text>
        <Text className={styles.deviceMeta}>{device ? `${device.name} · USB 打印机：${device.printer}` : '店里电脑需开机、登录并联网，K3 通过 USB 接入'}</Text>
        <Text className={styles.deviceMeta}>电脑在线且 K3 就绪后自动接收；出纸完成后由打印机页面计数自动回报，不需要手机蓝牙。</Text>
      </View>
      <Button className={styles.secondaryButton} disabled={disabledIf(Boolean(action))} onClick={() => setRefresh(value => value + 1)}>刷新状态</Button>
    </View>

    {!token ? <View className={styles.card}>
      <Text className={styles.sectionTitle}>连接店里打印电脑</Text>
      <Text className={styles.help}>扫描店里打印电脑上的连接二维码，即可连接标签打印；也可直接打开电脑提供的连接链接。</Text>
      <Button className={styles.primaryButton} disabled={disabledIf(Boolean(action))} onClick={() => void pair()}>{action || '扫描连接二维码'}</Button>
      {pairError && <Text className={styles.error}>{pairError}</Text>}
      <Text className={styles.sectionSubTitle}>可先浏览标签记录</Text>
      <View className={styles.tabs}>
        <Button className={kind === 'finished-product' ? styles.tabActive : styles.tab} onClick={() => switchKind('finished-product')}>成品标签</Button>
        <Button className={kind === 'paperboard-batch' ? styles.tabActive : styles.tab} onClick={() => switchKind('paperboard-batch')}>纸板批次标签</Button>
      </View>
      <Input ariaLabel='搜索标签记录' className={styles.search} value={query}
        placeholder={kind === 'finished-product' ? '搜索商品名称或规格' : '搜索批次号、板厂或纸板规格'}
        onInput={event => { setQuery(event.detail.value); setPage(1); }} />
      {loading ? <Text className={styles.empty}>正在查询记录…</Text> : listError ? <Text className={styles.error}>{listError}</Text>
        : !results.length ? <View className={styles.empty}>
          <Text>{total === 0 && !query.trim()
            ? `当前共享仓库还没有${kind === 'finished-product' ? '商品' : '纸板批次'}记录。`
            : '没有匹配记录，请更换关键词。'}</Text>
          {total === 0 && !query.trim() && <Button className={styles.secondaryButton} onClick={() =>
            void Taro.navigateTo({ url: kind === 'finished-product' ? '/pages/products/index' : '/pages/board-receive/index' })
          }>{kind === 'finished-product' ? '前往商品管理' : '新增纸板批次'}</Button>}
        </View> : <Text className={styles.help}>找到 {total} 条记录。连接打印电脑后可继续选择、预览与打印。</Text>}
    </View> : <>
      {(deviceError || (device && !device.online)) && <View className={styles.messageCard}>
        <Text>{deviceError || '店里电脑当前离线。让电脑开机、登录并恢复网络后，此页会自动重连；无需手机蓝牙。'}</Text>
      </View>}
      {device && !device.ready && <View className={styles.messageCard}>
        <Text>打印电脑在线，但 K3 当前未就绪。请检查 K3 电源、USB 连接、标签纸和电脑打印队列；恢复后刷新状态。</Text>
      </View>}
      {device && <View className={styles.card}>
        <Text className={styles.sectionTitle}>1 · 纸张配置与一次性校准</Text>
        <Text className={styles.help}>默认 70 × 100 mm，上边距 0.6 mm、其余 0.5 mm。纸板大字版浓度 4，成品及其他纸张浓度 3；不同配置分别校准。</Text>
        {device.profiles.filter(item => item.printerName === device.printer && profileMatchesKind(kind, item)).map(profile => <Button
          key={profile.profileId}
          className={profile.profileId === profileId ? styles.profileSelected : styles.profileButton}
          disabled={disabledIf(busy)}
          onClick={() => chooseProfile(profile)}
        >{profile.widthMm} × {profile.heightMm} mm · 浓度 {profile.density} · {profile.calibrated ? '已校准' : '待校准'}</Button>)}
        <View className={styles.mediaGrid}>
          {([
            ['widthMm', '实测宽度（mm）'], ['heightMm', '实测高度（mm）'],
            ['top', '上边距（mm）'], ['right', '右边距（mm）'],
            ['bottom', '下边距（mm）'], ['left', '左边距（mm）']
          ] as const).map(([key, title]) => <View className={styles.field} key={key}>
            <Text>{title}</Text>
            <Input ariaLabel={title} type='digit' value={media[key]} disabled={disabledIf(busy)}
              onInput={event => setMedia(value => ({ ...value, [key]: event.detail.value }))} />
          </View>)}
        </View>
        <Text className={styles.driverNote}>浓度：{configuredDensity}（电脑直接设置） · 纸型：间隙纸 · 标签尺寸范围：宽 20–120 mm、高 20–200 mm。</Text>
        <View className={styles.actions}>
          <Button className={styles.secondaryButton} disabled={disabledIf(Boolean(action) || !device.online)} onClick={() => void saveProfile()}>保存纸张配置</Button>
          <Button className={styles.secondaryButton} disabled={disabledIf(Boolean(action) || pending || !device.online || !device.ready || !configuredProfile || Boolean(currentProfile?.calibrated))}
            onClick={calibrate}>打印单张校准样张</Button>
        </View>
        {needsCalibration && <Text className={styles.help}>首次打印 1 张校准样张。等打印机确认出纸后检查实物尺寸与边距，再点“已核对校准实物”；只确认一次。普通标签由打印机确认出纸后自动完成。</Text>}
        {jobIsCurrentCalibration && job?.status === 'queued' && !currentProfile?.calibrated && <Button className={styles.primaryButton} disabled={disabledIf(Boolean(action))}
          onClick={() => void confirmCalibration()}>已核对校准实物</Button>}
      </View>}

      <View className={styles.card}>
        <Text className={styles.sectionTitle}>2 · 选择商品或纸板批次</Text>
        <View className={styles.tabs}>
          <Button className={kind === 'finished-product' ? styles.tabActive : styles.tab} disabled={disabledIf(busy)} onClick={() => switchKind('finished-product')}>成品标签</Button>
          <Button className={kind === 'paperboard-batch' ? styles.tabActive : styles.tab} disabled={disabledIf(busy)} onClick={() => switchKind('paperboard-batch')}>纸板批次标签</Button>
        </View>
        <Input ariaLabel='搜索标签记录' className={styles.search} value={query} disabled={disabledIf(busy)}
          placeholder={kind === 'finished-product' ? '搜索商品名称或规格' : '搜索批次号、板厂或纸板规格'}
          onInput={event => { setQuery(event.detail.value); setPage(1); }} />
        {loading ? <Text className={styles.empty}>正在查询记录…</Text>
          : listError ? <View className={styles.empty}><Text>{listError}</Text><Button className={styles.secondaryButton} onClick={() => setReload(value => value + 1)}>重新查询</Button></View>
          : !results.length ? <View className={styles.empty}>
            <Text>{total === 0 && !query.trim()
              ? `当前共享仓库还没有${kind === 'finished-product' ? '商品' : '纸板批次'}记录。`
              : '没有匹配记录，请更换关键词。'}</Text>
            {total === 0 && !query.trim() && <Button className={styles.secondaryButton} onClick={() =>
              void Taro.navigateTo({ url: kind === 'finished-product' ? '/pages/products/index' : '/pages/board-receive/index' })
            }>{kind === 'finished-product' ? '前往商品管理' : '新增纸板批次'}</Button>}
          </View>
              : results.map(item => <Button key={idOf(item)}
                  className={selected && selected.kind === item.kind && idOf(selected) === idOf(item) ? styles.recordSelected : styles.record}
                  disabled={disabledIf(busy)} onClick={() => void selectRecord(item.kind, idOf(item))}>
                {item.kind === 'finished-product'
                  ? <><Text className={styles.recordTitle}>{item.data.name}</Text><Text className={styles.help}>{item.data.specification || `${item.data.length || '—'} × ${item.data.width || '—'} mm`} · 当前库存 {item.data.stock} {item.data.unit}</Text></>
                  : <><Text className={styles.recordTitle}>{item.data.boardLength} × {item.data.boardWidth} cm · {item.data.fluteType}</Text><Text className={styles.help}>{item.data.customerName || '未填客户'} · {item.data.id} · {item.data.supplier} · {item.data.location || '未填库位'} · 余量 {item.data.remainingQty} 张</Text></>}
              </Button>)}
        <View className={styles.pagination}>
          <Button className={styles.secondaryButton} disabled={disabledIf(page <= 1 || loading || busy)} onClick={() => setPage(value => value - 1)}>上一页</Button>
          <Text>{page} / {Math.max(1, Math.ceil(total / PAGE_SIZE))} · 共 {total} 条</Text>
          <Button className={styles.secondaryButton} disabled={disabledIf(page * PAGE_SIZE >= total || loading || busy)} onClick={() => setPage(value => value + 1)}>下一页</Button>
        </View>
      </View>

      <View className={styles.card}>
        <Text className={styles.sectionTitle}>3 · 字段、预览与打印</Text>
        {!selected ? <Text className={styles.empty}>先选择商品或纸板批次。</Text> : <>
          <Text className={styles.help}>必需识别字段保留。点选可选字段；库存和批次数量按当前实测快照打印。</Text>
          <View className={styles.options}>
            {(kind === 'finished-product' ? productOptions : visibleBoardOptions).map(option => <Button
              key={option.key}
              className={optionState[option.key] ? styles.optionActive : styles.option}
              disabled={disabledIf(busy)}
              onClick={() => {
                if (kind === 'finished-product') {
                  setFinishedOptions(value => ({ ...value, [option.key]: !value[option.key] }));
                  if (option.key === 'printedAt') setFrozenAt(new Date().toISOString());
                } else setBoardFields(value => ({ ...value, [option.key]: !value[option.key],
                  ...(largeBoardTemplate && !value[option.key] && option.key === 'receivedQty' ? { remainingQtySnapshot: false } : {}),
                  ...(largeBoardTemplate && !value[option.key] && option.key === 'remainingQtySnapshot' ? { receivedQty: false } : {})
                }));
              }}
            >{optionState[option.key] ? '✓ ' : '+ '}{option.title}</Button>)}
          </View>
          {built.error && <Text className={styles.error}>{built.error}</Text>}
          {built.data && <View className={styles.fieldList}>
            {Object.entries(built.data).filter(([key]) => !['productUrl', 'batchUrl', 'unit'].includes(key)).map(([key, value]) =>
              <View className={styles.fieldRow} key={key}><Text>{fieldNames[key] || key}</Text><Text>{valueText(key, value, built.data!)}</Text></View>)}
            <View className={styles.fieldRow}><Text>二维码</Text><Text>系统生成只读详情链接</Text></View>
          </View>}
        </>}
        <Text className={styles.sectionSubTitle}>实际标签预览</Text>
        {!currentProfile ? <Text className={styles.previewEmpty}>先保存并选择纸张配置。</Text>
          : previewLoading ? <Text className={styles.previewEmpty}>正在生成标签预览…</Text>
            : previewError ? <Text className={styles.error}>{previewError}</Text>
              : preview ? <View className={styles.previewBox} style={{ aspectRatio: `${currentProfile.widthMm} / ${currentProfile.heightMm}` }}>
                <iframe ref={frame} title='K3 标签预览' className={styles.previewFrame}
                  sandbox='allow-same-origin' srcDoc={preview} onLoad={checkFrameGeometry} />
              </View>
                : <Text className={styles.previewEmpty}>选择记录后显示实际尺寸预览。</Text>}
        {preview && !previewLoading && !previewError && <Text className={previewFits ? styles.previewOkay : styles.error}>
          {previewFits ? `单张预览 ${currentProfile?.widthMm} × ${currentProfile?.heightMm} mm，未发现内容溢出。` : '无法确认标签边界或检测到内容溢出；请修改可选字段后再打印。'}
        </Text>}
        {previewWarnings.map(warning => <Text className={styles.error} key={warning}>{warning}</Text>)}
        <View className={styles.copyRow}>
          <Text>打印份数</Text>
          <Input ariaLabel='打印份数' type='number' value={copies} disabled={disabledIf(busy)} onInput={event => setCopies(event.detail.value)} />
          <Text className={styles.help}>最多 {maxCopies} 份；校准固定 1 份</Text>
        </View>
        {!copiesValid && <Text className={styles.error}>请输入 1–{maxCopies} 的整数份数。</Text>}
        {!currentProfile?.calibrated && currentProfile && <Text className={styles.help}>完成一次校准并核对实物后，才能打印正式标签。</Text>}
        {currentProfile && !configuredProfile && <Text className={styles.help}>纸张实测值已修改，请先保存纸张配置；当前预览与打印仍绑定已保存配置。</Text>}
        <Button className={styles.primaryButton} disabled={disabledIf(!canSubmit)} onClick={() => void submit()}>
          {busy ? action || '任务处理中…' : !device?.online || !device?.ready ? '等待打印电脑与 K3 就绪' : !currentProfile?.calibrated ? '请先完成一次校准' : '复核最新资料并发送到 K3'}
        </Button>
        {notice && <Text className={styles.notice}>{notice}</Text>}
        {error && <Text className={styles.error}>{error}</Text>}
      </View>

      {attempt && <View className={styles.card}>
        <Text className={styles.sectionTitle}>打印任务 · {job ? statusNames[job.status] || job.status : '正在查询原任务'}</Text>
        <Text className={styles.taskMeta}>目标：{attempt.printer} · {attempt.kind === 'calibration' ? '校准样张' : attempt.kind === 'finished-product' ? '成品标签' : '纸板批次标签'} · {attempt.copies} 份</Text>
        <Text className={styles.taskMeta}>任务编号：{attempt.id}</Text>
        {job?.message && <Text className={styles.taskMessage}>{job.message}</Text>}
        {(job?.created_at || job?.updated_at) && <Text className={styles.taskMeta}>更新时间：{cleanTimestamp(job.updated_at || job.created_at)}</Text>}
        {job?.status === 'queued' && <Text className={styles.success}>出纸已确认，任务完成。</Text>}
        {job?.status === 'uncertain' && <>
          <Text className={styles.error}>打印结果待确认。请核对实际出纸，再选择结果；此期间不会自动重发。</Text>
          <View className={styles.actions}>
            <Button className={styles.secondaryButton} disabled={disabledIf(Boolean(action))} onClick={() => void resolveJob('printed')}>已经出纸</Button>
            <Button className={styles.secondaryButton} disabled={disabledIf(Boolean(action))} onClick={() => void resolveJob('missing')}>没有出纸</Button>
          </View>
        </>}
        {jobIsCurrentCalibration && job?.status === 'queued' && !currentProfile?.calibrated &&
          <Text className={styles.help}>请检查校准样张实物，再回到上方点“已核对校准实物”。</Text>}
        {job && ['failed', 'expired'].includes(job.status) && <Button className={styles.secondaryButton}
          disabled={disabledIf(Boolean(action) || pending || !device?.online || !device.ready)} onClick={retryJob}>确认任务失败后重新打印</Button>}
        {!job && jobError && <Text className={styles.error}>{jobError}</Text>}
        {notFound && <Button className={styles.secondaryButton} disabled={disabledIf(Boolean(action) || !device?.online || !device.ready)}
          onClick={resumeMissingJob}>沿用原任务编号重新发送</Button>}
        {!deviceForAttempt && <Text className={styles.error}>此任务绑定到另一台打印电脑；当前没有自动查询或重新发送。</Text>}
      </View>}
      <View className={styles.card}>
        <Button className={styles.textButton} disabled={disabledIf(Boolean(action) || pending)} onClick={() => {
          savePrintPair('');
          setToken('');
          setDevice(undefined);
          setProfileId('');
          setNotice('已断开当前打印电脑配对。');
        }}>更换打印电脑</Button>
        <Text className={styles.help}>标签通过店里电脑已有远程打印接收通道发送，直接交给已配置的 USB K3，不会走送货单 630K，也不会更改库存。</Text>
      </View>
    </>}
  </View>;
}
