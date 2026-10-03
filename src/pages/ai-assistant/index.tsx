import { useCallback, useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import { executeAiCommand, getAiCapabilities, getAiStatus, prepareAiCommand, prepareAiPhoto, prepareAiVoice, readAiAudio, readAiPhoto, reviseAiCommand, testAiConnection } from '@/services/ai';
import type { AiCapability, AiDocument, AiIntent, AiPlan, AiResult, AiSchema, AiStatus } from '@/services/ai';
import DraftForm, { normalized } from './form';
import AiSettings from './settings';
import VoiceInput from './voice';
import ChatIcon from './icons';
import Message from './message';
import type { ChatMessage } from './message';
import { session, watchSession } from '@/services/session';
import styles from './index.module.scss';

const labels: Record<string, string> = { id: '编号', name: '名称', product_id: '商品编号', product_name: '商品', specification: '规格', stock: '库存', unit: '单位', price: '单价', unit_price: '单价', quantity: '数量', amount: '金额', customer_name: '客户', supplier_name: '供应商', phone: '电话', contact: '联系人', debt: '应收', payable: '应付', order_no: '订单号', status: '状态', remark: '备注', date: '日期', total_amount: '货款合计', remainingQty: '剩余张数', receivedQty: '实收张数', supplier: '板厂', totalProducts: '商品种类', totalStock: '库存数量', totalValue: '库存总值', todayIn: '今日入库', todayOut: '今日出库', totalReceivable: '应收', totalPayable: '应付', lowStock: '库存预警' };
const legacySchema = (intent: AiIntent): AiSchema => ({ type: 'object', required: intent.action === 'print' ? ['transaction_id'] : ['product_id', 'quantity'], properties: intent.action === 'print' ? { transaction_id: { type: 'integer', title: '流水编号' } } : {
  product_id: { type: 'integer', title: '商品编号' }, product_name: { type: 'string', title: '商品完整名称' }, quantity: { type: 'number', title: '数量' }, unit: { type: 'string', title: '库存单位' }, unit_price: { type: 'number', title: '单价' },
  ...(intent.action === 'stock_in' ? { supplier_id: { type: 'integer', title: '供应商编号' } } : { customer_id: { type: 'integer', title: '客户编号' } }), remark: { type: 'string', title: '备注' }
} });
const textError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const navigate = (url: string) => ['/pages/home/index', '/pages/board-stock/index', '/pages/outbound/index', '/pages/mine/index'].includes(url) ? Taro.switchTab({ url }) : Taro.navigateTo({ url });
const setPath = (source: any, path: string, value: any) => {
  const parts = path.split('.').filter(Boolean);
  const result = Array.isArray(source) ? [...source] : { ...(source || {}) };
  let target = result;
  let original = source;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const nextOriginal = original?.[key];
    const next = Array.isArray(nextOriginal) ? [...nextOriginal] : { ...(nextOriginal || {}) };
    target[key] = next;
    target = next;
    original = nextOriginal;
  }
  if (parts.length) target[parts[parts.length - 1]] = value;
  return result;
};

export default function AiAssistantPage() {
  const [status, setStatus] = useState<AiStatus>();
  const [capabilities, setCapabilities] = useState<AiCapability[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionTest, setConnectionTest] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [voiceSeconds, setVoiceSeconds] = useState<number>();
  const chatEnd = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [voice, setVoice] = useState('');
  const [recording, setRecording] = useState(false);
  const [plan, setPlan] = useState<AiPlan>();
  const [draft, setDraft] = useState<any>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [outcome, setOutcome] = useState<AiResult>();
  const [document, setDocument] = useState<AiDocument>();
  const [printLoaded, setPrintLoaded] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const context = useRef<AiIntent>();
  const working = useRef(false);
  const alive = useRef(true);
  const canEdit = !busy && !unconfirmed && !recording;
  const schema = plan?.schema || (plan ? legacySchema(plan.intent) : undefined);
  const connect = useCallback(async () => {
    setConnectionError('');
    setConnectionTest('');
    try {
      const [nextStatus, catalog] = await Promise.all([getAiStatus(), getAiCapabilities()]);
      if (alive.current) { setStatus(nextStatus); setCapabilities(catalog.capabilities || []); }
    } catch (e) { if (alive.current) setConnectionError('无法连接仓库助手：' + textError(e)); }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (session()) void connect();
    const unwatch = watchSession(() => { if (session()) void connect(); });
    return () => { alive.current = false; unwatch(); };
  }, [connect]);
  useEffect(() => { const content = contentRef.current; if (content) content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' }); }, [messages, busy, plan, moreOpen, emojiOpen]);
  useEffect(() => {
    const inputElement = inputRef.current;
    if (inputElement) { inputElement.style.height = '40px'; inputElement.style.height = `${Math.min(112, Math.max(40, inputElement.scrollHeight))}px`; }
  }, [input, voiceOpen]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const page = pageRef.current;
      if (page) {
        const top = page.getBoundingClientRect().top;
        page.style.setProperty('--ai-chat-height', `${Math.max(180, (viewport?.height || window.innerHeight) + (viewport?.offsetTop || 0) - top)}px`);
      }
    };
    resize(); viewport?.addEventListener('resize', resize); window.addEventListener('resize', resize);
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize); };
  }, []);
  const messageId = () => `message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const addMessage = (role: 'user' | 'assistant', text: string) => setMessages(previous => [...previous.slice(-39), { id: messageId(), at: Date.now(), role, text }]);
  const accept = (next: AiPlan) => {
    setPlan(next); context.current = next.intent.action === 'unsupported' ? undefined : next.intent;
    const editable = next.command || next.intent;
    if (editable.parameters) setDraft(editable.parameters);
    else { const { action, ...fields } = editable; setDraft(fields); }
    setDirty(false); setConflict(false); setOutcome(undefined);
    addMessage('assistant', next.reply);
  };
  const task = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { if (alive.current) setError(textError(e)); }
    finally { working.current = false; if (alive.current) setBusy(false); }
  };
  const send = (message = input, recordedAudio?: string, duration?: number, retry?: ChatMessage) => {
    const outgoingVoice = retry?.audio || recordedAudio || voice;
    const outgoingPhotos = retry?.images || photos;
    const outgoingText = retry ? retry.text : message.trim();
    if ((!recordedAudio && !canEdit) || busy || unconfirmed || working.current || (!outgoingText && !outgoingPhotos.length && !outgoingVoice)) return;
    const text = outgoingText || (outgoingVoice ? '' : '请识别入库单，整理入库明细');
    const sent: ChatMessage = retry ? { ...retry, state: 'sending' } : { id: messageId(), at: Date.now(), role: 'user', text: outgoingText, state: 'sending', images: outgoingPhotos, audio: outgoingVoice || undefined, seconds: duration || voiceSeconds };
    if (retry) setMessages(previous => previous.map(item => item.id === sent.id ? sent : item));
    else setMessages(previous => [...previous.slice(-39), sent]);
    setMoreOpen(false); setEmojiOpen(false);
    void task(async () => {
      if (recordedAudio) setVoice(recordedAudio);
      setPlan(undefined); setDocument(undefined);
      try {
      const next = outgoingVoice ? await prepareAiVoice(outgoingVoice, context.current, outgoingPhotos, text)
        : outgoingPhotos.length ? await prepareAiPhoto(outgoingPhotos, text, context.current) : await prepareAiCommand(text, context.current);
      if (alive.current) {
        setMessages(previous => previous.map(item => item.id === sent.id ? { ...item, state: 'sent', transcript: next.transcript, seconds: next.durationSeconds || item.seconds } : item));
        setInput(''); setPhotos([]); setVoice(''); setVoiceSeconds(undefined); accept(next);
      }
      } catch (e) { if (alive.current) setMessages(previous => previous.map(item => item.id === sent.id ? { ...item, state: 'failed' } : item)); throw e; }
    });
  };
  const startTool = (capability: AiCapability) => {
    if (!canEdit) return;
    void task(async () => { setCatalogOpen(false); context.current = undefined; setDocument(undefined); setPhotos([]); setVoice(''); setVoiceOpen(false); accept(await reviseAiCommand({ action: capability.action, parameters: {} })); });
  };
  const checkDraft = () => {
    if (!plan || !schema || !canEdit) return;
    void task(async () => {
      const parameters = normalized(draft, schema);
      accept(await reviseAiCommand(plan.intent.parameters ? { action: plan.intent.action, parameters } : { action: plan.intent.action, ...parameters }));
    });
  };
  const execute = () => {
    if (!plan?.command || dirty || working.current) return;
    const command = plan.command;
    const readOnly = command.action === 'print' || capabilities.find(item => item.action === command.action)?.mode === 'print';
    void task(async () => {
      try {
        const result = await executeAiCommand(command, plan.revision, readOnly);
        if (!alive.current) return;
        setUnconfirmed(false); setPlan(undefined); context.current = undefined; setOutcome(result); setPhotos([]);
        addMessage('assistant', result.reply);
        if (result.document) { setPrintLoaded(false); setDocument(result.document); }
      } catch (e: any) {
        if (e.code === 'REVISION_CONFLICT') { setConflict(true); setUnconfirmed(false); setDirty(true); }
        else if (!readOnly && (!e.statusCode || e.statusCode >= 500)) setUnconfirmed(true);
        throw e;
      }
    });
  };
  const pickPhoto = (camera: boolean) => {
    if (!canEdit || photos.length >= 3) return;
    if (status?.mode !== 'model') { setSettingsOpen(true); setError('拍单识别需要先接入支持图片输入的模型；当前仍可使用基础查询和手动填写入库。'); return; }
    if (typeof window === 'undefined' || !window.document) { setError('请在手机 App 或网页版中拍摄/上传单据'); return; }
    const picker = window.document.createElement('input');
    picker.type = 'file'; picker.accept = 'image/jpeg,image/png,image/webp';
    if (camera) picker.setAttribute('capture', 'environment');
    picker.onchange = () => {
      const file = picker.files?.[0]; if (!file) return;
      void task(async () => {
        const photo = await readAiPhoto(file);
        if (alive.current) { setPhotos(previous => [...previous, photo].slice(0, 3)); setMoreOpen(false); setPlan(undefined); context.current = undefined; }
      });
    };
    picker.click();
  };
  const pickVoiceFile = () => {
    if (!canEdit) return;
    const picker = window.document.createElement('input'); picker.type = 'file'; picker.accept = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm';
    picker.onchange = () => {
      const file = picker.files?.[0]; if (!file) return;
      void task(async () => { const audio = await readAiAudio(file, file.name); if (alive.current) { setVoice(audio); setVoiceSeconds(undefined); setMoreOpen(false); } });
    };
    picker.click();
  };
  const newTask = () => {
    if (!canEdit) return;
    setMessages([]); setPlan(undefined); context.current = undefined; setInput(''); setPhotos([]); setVoice(''); setVoiceSeconds(undefined); setMoreOpen(false); setMenuOpen(false); setEmojiOpen(false); setDocument(undefined); setOutcome(undefined); setError(''); setConflict(false); setDirty(false);
  };
  const printOutcome = () => {
    if (!outcome || !canEdit) return;
    const command = outcome.transaction ? { action: 'print', transaction_id: outcome.transaction.id }
      : { action: 'print_record', parameters: { resource: outcome.action === 'receipt_in' ? 'delivery_notes' : 'orders', id: String(outcome.result.id) } };
    void task(async () => {
      const printed = await executeAiCommand(command, outcome.revision, true);
      if (printed.document) { setPrintLoaded(false); setDocument(printed.document); }
    });
  };
  const print = () => {
    if (!printLoaded) return;
    try {
      if (!frame.current?.contentWindow?.print) throw new Error('当前设备未提供打印功能，请在电脑浏览器打开单据');
      frame.current.contentWindow.focus(); frame.current.contentWindow.print();
    } catch (e) { setError(textError(e)); }
  };

  return <div ref={pageRef} className={styles.page} data-ai-assistant='20261003' data-ai-media='20261004' data-ai-chat='20261004-wechat'>
    <div className={styles.header}>
      <button data-ai-control="button" className={styles.back} aria-label='返回首页' onClick={() => { if (Taro.getCurrentPages().length > 1) Taro.navigateBack(); else void navigate('/pages/home/index'); }}><ChatIcon name='back' /></button>
      <div className={styles.heading}><span className={styles.title}>AI 助手</span></div>
      <button data-ai-control="button" className={styles.headerMore} aria-label='聊天设置' aria-expanded={menuOpen} disabled={!canEdit} onClick={() => setMenuOpen(value => !value)}><ChatIcon name='more' /></button>
    </div>
    <main ref={contentRef} className={styles.content} aria-label="对话与业务结果">
      {menuOpen && <div className={styles.chatMenu} aria-label='聊天设置面板'>
        <span className={styles.hint}>{connectionError || (status?.mode === 'model' ? `已连接 ${status.model}` : status?.message || '正在连接…')}</span>
        <button data-ai-control='button' onClick={() => { setCatalogOpen(true); setMenuOpen(false); }}>可用功能</button>
        <button data-ai-control='button' onClick={() => { setSettingsOpen(true); setMenuOpen(false); }}>接入设置</button>
        <button data-ai-control='button' onClick={newTask}>新任务</button>
      </div>}
      {settingsOpen && <><div className={styles.connection}>
        <span className={`${styles.dot} ${status?.mode === 'model' ? styles.online : ''}`} />
        <div className={styles.grow}><span className={styles.connectionTitle}>{status?.mode === 'model' ? `模型已配置 · ${status.model}` : status?.mode === 'misconfigured' ? '模型配置待完善' : '基础指令模式'}</span><span className={styles.hint}>{connectionError || status?.message || '正在检查服务连接…'}</span></div>
        <button data-ai-control="button" className={styles.textButton} disabled={!canEdit} onClick={() => setSettingsOpen(value => !value)}>接入设置</button>
      </div>
      <div className={styles.actions}>
        <button data-ai-control="button" className={styles.secondary} disabled={busy} onClick={() => void connect()}>刷新状态</button>
        <button data-ai-control="button" className={styles.secondary} disabled={busy || status?.mode !== 'model'} onClick={() => { setConnectionTest(''); void task(async () => { const result = await testAiConnection(); if (alive.current) setConnectionTest(result.message); }); }}>检测模型连接</button>
      </div>
      {connectionTest && <div className={styles.success} role='status'>{connectionTest}</div>}
      </>}
      {settingsOpen && <AiSettings onSaved={() => void connect()} onClose={() => setSettingsOpen(false)} />}
      {catalogOpen && <div className={styles.card}><span className={styles.sectionTitle}>可以让助手做什么</span><span className={styles.hint}>选择功能可直接填写；配置模型后支持自由描述。页面类功能会打开对应页面。</span><div className={styles.catalog}>{capabilities.map(item => <button data-ai-control="button" key={item.action} disabled={!canEdit} className={styles.tool} onClick={() => startTool(item)}>{item.title}<span className={styles.toolMode}>{({ read: '查询', write: '填写后提交', print: '打印', navigate: '打开页面' })[item.mode]}</span></button>)}</div></div>}
      {messages.length === 0 && <>
        <span className={styles.chatTime}>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
        <Message item={{ id: 'welcome', role: 'assistant', at: 0, text: '你好，我是仓库 AI 助手。\n可以发文字、语音或入库单照片，我帮你整理。' }} onRetry={() => {}} onError={setError} />
      </>}
      {messages.map((item, index) => <div key={item.id}>
        {(index === 0 || item.at - messages[index - 1].at >= 5 * 60 * 1000) && <span className={styles.chatTime}>{new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
        <Message item={item} onRetry={() => send('', undefined, undefined, item)} onError={setError} />
      </div>)}
      {plan && ['ready', 'needs_input'].includes(plan.status) && schema && <div className={styles.card}>
        <div className={styles.row}><span className={styles.sectionTitle}>{plan.title || (plan.intent.action === 'print' ? '打印单据' : plan.intent.action === 'stock_in' ? '商品入库' : '商品出库')}</span><span className={styles.tag}>{plan.status === 'ready' && !dirty ? '待核对' : '待补充'}</span></div>
        {photos.length > 0 && <span className={styles.hint}>请对照原单核对日期、实收数量、规格和单价；空白字段表示尚未确认。</span>}
        {plan.preview?.product_name && <div className={styles.summary}><span>{plan.preview.product_name} · {plan.preview.specification}</span><span>库存 {plan.preview.stock_before} → {plan.preview.stock_after} {plan.preview.unit}</span><span>金额 ¥{Number(plan.preview.amount).toFixed(2)}</span></div>}
        {plan.candidates && <div className={styles.candidates}>
          {(Array.isArray(plan.candidates) ? plan.candidates : Object.entries(plan.candidates).map(([kind, candidate]) => ({ path: `${kind}_id`, kind, items: candidate.items }))).map((candidate, candidateIndex) => candidate.items.length > 0 && <div className={styles.candidateGroup} key={`${candidate.path}-${candidateIndex}`}>
            <span className={styles.label}>请选择{({ product: '商品', customer: '客户', supplier: '供应商' } as Record<string, string>)[candidate.kind] || '记录'}：</span>
            {candidate.items.map(item => <button data-ai-control="button" key={String(item.id)} className={styles.candidate} disabled={!canEdit} onClick={() => {
              setDraft(previous => setPath(previous, candidate.path, item.id));
              if (candidate.path.endsWith('product_id') && Object.prototype.hasOwnProperty.call(item, 'specification')) setDraft(previous => setPath(previous, candidate.path.replace(/product_id$/, 'specification'), item.specification || ''));
              setDirty(true);
            }}>{item.name}{item.specification ? ` · ${item.specification}` : ''}{item.stock !== undefined ? ` · ${item.unit ? '库存' : '未结余额'} ${item.stock}${item.unit || ''}` : ''} · 编号 {item.id}</button>)}
          </div>)}
        </div>}
        <DraftForm schema={schema} value={draft} disabled={!canEdit} onChange={value => { setDraft(value); setDirty(true); }} />
        <div className={styles.actions}><button data-ai-control="button" className={styles.secondary} disabled={!canEdit} onClick={checkDraft}>{conflict ? '刷新并重新核对' : '核对填写内容'}</button>
          {plan.status === 'ready' && <button data-ai-control="button" className={plan.destructive ? styles.danger : styles.primary} disabled={busy || dirty} onClick={execute}>{busy ? '处理中…' : unconfirmed ? '核对本次提交结果' : plan.intent.action.startsWith('print') ? '生成打印预览' : plan.destructive ? '确认执行作废/停用' : '确认提交'}</button>}</div>
        <button data-ai-control="button" className={styles.textButton} disabled={!canEdit} onClick={() => void navigate('/pages/products/index')}>查看商品与编号 ›</button>
      </div>}
      {plan?.result && <div className={styles.card}><span className={styles.sectionTitle}>{plan.result.title} · 共 {plan.result.total} 条</span>
        {plan.result.items.length === 0 && <span className={styles.hint}>没有符合条件的记录</span>}
        {plan.result.items.map((item, index) => <div className={styles.record} key={String(item.id || index)}>{Object.entries(item).filter(([key, value]) => key in labels && value !== null && typeof value !== 'object').map(([key, value]) => <div className={styles.detail} key={key}><span>{labels[key]}</span><span>{String(value)}</span></div>)}</div>)}
        {plan.result.page && <div className={styles.actions}><button data-ai-control="button" className={styles.secondary} disabled={busy || plan.result.page <= 1} onClick={() => void task(async () => accept(await reviseAiCommand({ action: 'query', parameters: { ...plan.intent.parameters, page: plan.result!.page! - 1 } })))}>上一页</button><button data-ai-control="button" className={styles.secondary} disabled={busy || plan.result.page * (plan.result.page_size || 20) >= plan.result.total} onClick={() => void task(async () => accept(await reviseAiCommand({ action: 'query', parameters: { ...plan.intent.parameters, page: plan.result!.page! + 1 } })))}>下一页</button></div>}
      </div>}
      {plan?.navigation && <button data-ai-control="button" className={styles.primary} onClick={() => void navigate(plan.navigation!.url)}>打开{plan.navigation.title}</button>}
      {outcome?.status === 'completed' && <div className={styles.success}><span>{outcome.reply}</span>{(outcome.transaction || (outcome.result?.id && ['receipt_in', 'order_create'].includes(outcome.action))) && <button data-ai-control="button" className={styles.secondary} disabled={busy} onClick={printOutcome}>打印本单</button>}</div>}
      {document && <div className={styles.card}><span className={styles.sectionTitle}>{document.title}</span><span className={styles.hint}>下方是实际单据。点击打印可选择打印机或保存 PDF。</span><iframe className={styles.printFrame} title='单据打印预览' ref={frame} srcDoc={document.html} sandbox='allow-same-origin allow-modals' onLoad={() => setPrintLoaded(true)} /><button data-ai-control="button" className={styles.primary} disabled={!printLoaded} onClick={print}>打印 / 保存 PDF</button></div>}
      {error && <div className={styles.error} role='alert'>{error}{unconfirmed && <span className={styles.hint}>本次提交结果尚未确认，请使用上方按钮核对；暂时保留同一笔请求。</span>}</div>}
      {busy && <div className={styles.thinking}>对方正在处理…</div>}
      <div ref={chatEnd} />
    </main>
    <div className={styles.composer}>
      {voice && !busy && <div className={styles.voicePreview}><audio controls src={voice} aria-label='待发送语音' /><button data-ai-control='button' aria-label='移除语音' disabled={!canEdit} onClick={() => setVoice('')}><ChatIcon name='close' /></button></div>}
      {photos.length > 0 && <div className={styles.photos}>{photos.map((photo, index) => <div key={index} className={styles.photo}><img className={styles.photoPreview} src={photo} alt={`单据照片 ${index + 1}`} onClick={() => Taro.previewImage({ current: photo, urls: photos })} /><button data-ai-control="button" disabled={!canEdit} className={styles.removePhoto} aria-label={`移除照片${index + 1}`} onClick={() => setPhotos(previous => previous.filter((_, i) => i !== index))}>×</button></div>)}</div>}
      <div className={styles.chatBar}>
        <button data-ai-control="button" className={styles.chatIcon} disabled={!canEdit} aria-label={voiceOpen ? '键盘输入' : '发语音'} onClick={() => { setVoiceOpen(value => !value); setMoreOpen(false); setEmojiOpen(false); }}><ChatIcon name={voiceOpen ? 'keyboard' : 'voice'} /></button>
        {!voiceOpen && <textarea ref={inputRef} data-ai-control="textarea" className={styles.messageInput} aria-label='输入仓库指令' placeholder='' value={input} disabled={!canEdit} maxLength={2000} rows={1} onFocus={() => { setMoreOpen(false); setEmojiOpen(false); }} onChange={event => setInput(event.currentTarget.value)} />}
        {voiceOpen && <VoiceInput disabled={busy || unconfirmed} available={!!status?.voice?.available} onSend={(audio, seconds) => send(input, audio, seconds)} onRecording={setRecording} onError={setError} />}
        <button data-ai-control='button' className={styles.chatIcon} aria-label={emojiOpen ? '收起表情' : '表情'} aria-expanded={emojiOpen} disabled={!canEdit} onClick={() => { setEmojiOpen(value => !value); setMoreOpen(false); setVoiceOpen(false); inputRef.current?.blur(); }}><ChatIcon name={emojiOpen ? 'keyboard' : 'smile'} /></button>
        {(input.trim() || photos.length || voice) ? <button data-ai-control="button" className={styles.send} disabled={!canEdit} onClick={() => send()}>{voice ? '发送语音' : photos.length ? '发送照片' : '发送'}</button>
          : <button data-ai-control="button" className={styles.chatIcon} aria-label='更多发送方式' aria-expanded={moreOpen} disabled={!canEdit} onClick={() => { setMoreOpen(value => !value); setEmojiOpen(false); inputRef.current?.blur(); }}><ChatIcon name='plus' /></button>}
      </div>
      {emojiOpen && <div className={styles.emojiPanel} aria-label='表情面板'>{['😀', '😊', '😂', '🤔', '👍', '👌', '🙏', '❤️', '😅', '😎', '🎉', '✅', '📦', '🧾', '🚚', '🖨️', '🙂', '😄', '🙌', '💪', '🌹', '👏', '🤝', '💡'].map(emoji => <button data-ai-control='button' key={emoji} aria-label={`插入表情 ${emoji}`} onClick={() => setInput(previous => (previous + emoji).slice(0, 2000))}>{emoji}</button>)}</div>}
      {moreOpen && <div className={styles.composerTools} aria-label='更多发送面板'>
        <button data-ai-control="button" disabled={!canEdit || photos.length >= 3} aria-label='上传照片' onClick={() => pickPhoto(false)}><span><ChatIcon name='photo' /></span>照片</button>
        <button data-ai-control="button" disabled={!canEdit || photos.length >= 3} aria-label='拍入库单' onClick={() => pickPhoto(true)}><span><ChatIcon name='camera' /></span>拍摄</button>
        <button data-ai-control='button' disabled={!canEdit} aria-label='上传语音' onClick={pickVoiceFile}><span><ChatIcon name='file' /></span>语音文件</button>
        <button data-ai-control='button' disabled={!canEdit} onClick={() => { setCatalogOpen(true); setMoreOpen(false); }}><span><ChatIcon name='tools' /></span>可用功能</button>
        <button data-ai-control="button" disabled={!canEdit} onClick={newTask}><span><ChatIcon name='new' /></span>新任务</button>
        <button data-ai-control='button' disabled={!canEdit} onClick={() => { setSettingsOpen(true); setMoreOpen(false); }}><span><ChatIcon name='settings' /></span>接入设置</button>
      </div>}
    </div>
  </div>;
}
