(() => {
  const app = document.querySelector('.app');
  const native = new URLSearchParams(location.search).get('client') === 'app';
  const apiBase = native ? 'https://youxishen.online/api' : '/api';
  const labelPage = 'spec-test.html' + (native ? '?client=app' : '');
  let state, token = '', busy = false, opened = '', query = '';
  const quantities = new Map();
  const escaped = v => String(v || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function notify(message) { const t = document.getElementById('toast'); t.textContent = message; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 5000); }
  async function api(url, method = 'GET', data, headers = {}) {
    const response = await fetch(apiBase + url, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers }, body: data ? JSON.stringify(data) : undefined });
    const body = await response.json(); if (!response.ok || !body.success) throw new Error(body.message || '服务器连接失败');
    return { data: body.data, revision: response.headers.get('X-Warehouse-Revision') };
  }
  async function save(next) {
    if (busy) throw new Error('正在保存，请稍候');
    busy = true;
    try { state = (await api('/customer-dimensions', 'PUT', next)).data; render(); }
    finally { busy = false; }
  }
  function render() {
    const theme = state.theme;
    document.documentElement.style.cssText = '--custom-bg:' + theme.bg + ';--custom-card:' + theme.card + ';--custom-accent:' + theme.accent;
    const customers = state.customers.filter(c => (c.name + c.specs.map(s => s.goods + s.size).join(' ')).includes(query));
    app.innerHTML = '<header><div><div class="eyebrow">曙光 · 客户规格</div><h1>' + escaped(theme.title) + '</h1></div><button class="blue" data-action="new-company">＋ 公司</button></header><div class="sub">每家公司一本尺寸本，选规格就能打印或发货。</div><div class="design-tools"><button data-action="theme">自定义界面</button><button data-action="refresh">刷新资料</button></div><div class="summary"><div class="live">客户规格总览</div><div class="number">' + state.customers.length + '<small>家公司</small></div><div class="stats"><div><strong>' + state.customers.reduce((n,c) => n + c.specs.length,0) + '</strong><span>常用规格</span></div><div><strong>成品 / 纸板</strong><span>两种标签格式</span></div></div></div><input class="search" placeholder="搜索公司、货物名称或尺寸" value="' + escaped(query) + '"><div class="section"><strong>我的客户</strong><span>点公司展开全部规格</span></div>' + customers.map(c => '<section class="company ' + (c.id === opened ? '' : 'collapsed') + '" data-id="' + escaped(c.id) + '"><div class="company-head" data-action="expand"><div><strong>' + escaped(c.name) + '</strong><p>' + c.specs.length + ' 个常用规格</p></div><span class="tag">' + (c.id === opened ? '收起' : '展开') + ' ⌄</span></div><div class="specs"><div class="company-edit"><button data-action="edit-company">修改公司</button></div>' + c.specs.map(s => '<div class="spec" data-spec="' + escaped(s.id) + '">' + (s.goods ? '<div class="spec-name">' + escaped(s.goods) + '</div>' : '') + '<div class="spec-value">' + escaped(s.size) + '<small>' + escaped(s.sizeUnit) + '</small></div><div class="meta">' + escaped(s.material) + ' · ' + escaped(s.kind) + ' · 单位：' + escaped(s.unit) + '</div><div class="controls"><label>本次数量</label><input aria-label="本次数量" type="number" min="1" step="1" value="' + escaped(quantities.get(s.id)) + '"><span>' + escaped(s.unit) + '</span></div><div class="actions"><button data-action="print">打印标签</button><button class="blue" data-action="order">出库发货 →</button></div><div class="minor"><span>尺寸长期保存</span><button data-action="edit-spec">修改规格</button></div></div>').join('') + '<button class="new-spec" data-action="new-spec">＋ 添加这家公司的规格</button></div></section>').join('') + (!customers.length ? '<div class="empty">' + (query ? '没有匹配的公司或规格' : '还没有公司，点击右上角“＋ 公司”开始录入。') + '</div>' : '') + '<div class="footer">资料保存到服务器，多设备打开同一网址可查看。<br>发货前在出库页核对商品、库存和数量。</div>';
  }
  function dialog(title, fields, action) {
    const mask = document.createElement('div'); mask.className = 'editor-mask';
    mask.setAttribute('role', 'dialog'); mask.setAttribute('aria-modal', 'true'); mask.setAttribute('aria-label', title);
    mask.innerHTML = '<form class="editor-dialog"><h2>' + escaped(title) + '</h2>' + fields.map(f => '<label>' + escaped(f.label) + (f.options ? '<select name="' + f.key + '">' + f.options.map(v => '<option ' + (v === f.value ? 'selected' : '') + '>' + escaped(v) + '</option>').join('') + '</select>' : '<input name="' + f.key + '" type="' + (f.type || 'text') + '" value="' + escaped(f.value) + '" maxlength="100" step="any" ' + (f.required ? 'required' : '') + '>') + '</label>').join('') + '<div class="form-error" role="alert"></div><div class="editor-actions"><button type="button" data-close>取消</button><button class="blue" type="submit">确认</button></div></form>';
    document.body.appendChild(mask); mask.querySelector('[data-close]').onclick = () => mask.remove();
    mask.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const button = mask.querySelector('[type=submit]'); if (button.disabled) return;
      button.disabled = true;
      try { const values = Object.fromEntries([...new FormData(e.target)].map(([k,v]) => [k,v.trim()])); if(fields.some(f => f.required && !values[f.key])) throw new Error('请填写必填资料'); await action(values); mask.remove(); }
      catch (e) { mask.querySelector('.form-error').textContent = e.message; }
      finally { button.disabled = false; }
    };
  }
  const copy = () => structuredClone(state);
  const quantity = s => { const q = Number(quantities.get(s.id)); if (!Number.isSafeInteger(q) || q <= 0) throw new Error('请先填写大于零的整数数量'); return q; };
  app.addEventListener('input', e => {
    if (e.target.matches('.search') && !e.isComposing) { query = e.target.value; const position = e.target.selectionStart; render(); const input = app.querySelector('.search'); input.focus(); input.setSelectionRange(position,position); }
    if (e.target.matches('.controls input')) quantities.set(e.target.closest('.spec').dataset.spec, e.target.value);
  });
  app.addEventListener('compositionend', e => { if (e.target.matches('.search')) e.target.dispatchEvent(new InputEvent('input', { bubbles: true })); });
  app.addEventListener('click', async e => {
    const target = e.target.closest('[data-action]'); if (!target || busy) return;
    const action = target.dataset.action, id = target.closest('.company')?.dataset.id, specId = target.closest('.spec')?.dataset.spec;
    const company = state.customers.find(c => c.id === id), spec = company?.specs.find(s => s.id === specId);
    try {
      if (action === 'expand') { opened = opened === id ? '' : id; render(); }
      if (action === 'refresh') { state = (await api('/customer-dimensions')).data; render(); }
      if (['new-company','edit-company'].includes(action)) dialog(company ? '修改公司' : '新增公司', [{key:'name',label:'公司名称',value:company?.name,required:true}], async v => { const next = copy(); if(company) next.customers.find(c=>c.id===id).name=v.name; else { opened=crypto.randomUUID(); next.customers.push({id:opened,name:v.name,specs:[]}); } await save(next); });
      if (['new-spec','edit-spec'].includes(action)) dialog(spec ? '修改规格' : '添加常用规格', [{key:'goods',label:'货物名称（没有名字可留空）',value:spec?.goods},{key:'size',label:'规格尺寸',value:spec?.size,required:true},{key:'sizeUnit',label:'尺寸单位',value:spec?.sizeUnit || 'cm',options:['cm','mm']},{key:'kind',label:'标签名称',value:spec?.kind || '成品',options:['成品','纸板']},{key:'material',label:'材质（选填）',value:spec?.material},{key:'unit',label:'数量单位',value:spec?.unit || '个',options:['个','张','件','套']}], async v => { const next=copy(),c=next.customers.find(c=>c.id===id); const s={...v,id:spec?.id || crypto.randomUUID()}; if(spec)c.specs=c.specs.map(old=>old.id===spec.id?s:old);else c.specs.push(s); await save(next); });
      if (action === 'theme') dialog('自定义界面', [{key:'title',label:'页面标题',value:state.theme.title,required:true},...['accent','bg','card'].map((key,i)=>({key,label:['按钮颜色','页面背景','卡片背景'][i],type:'color',value:state.theme[key]}))],async v=>{const next=copy();next.theme=v;await save(next);});
      if (action === 'print') { const q=quantity(spec); dialog('选择标签纸尺寸',[{key:'width',label:'宽度 × 高度（按实际纸张）',value:'70×100mm',options:['70×100mm','50×100mm','80×100mm']}],async v=>{ const hash=new URLSearchParams({view:'1',width:v.width.split('×')[0],name:spec.kind,company:company.name,goods:spec.goods,specification:spec.size+' '+spec.sizeUnit,unit:spec.unit,quantity:String(q)}); location.href=labelPage+'#'+hash; }); }
      if (action === 'order') {
        const q=quantity(spec), key=crypto.randomUUID();
        dialog('发货开单 · '+q+spec.unit,[{key:'price',label:'本次单价（元，可填0）',value:'0',type:'number',required:true}],async v=>{
          const price=Number(v.price);if(!Number.isFinite(price)||price<0)throw new Error('单价格式不正确');
          const current=await api('/orders');
          const order=(await api('/customer-dimensions/order','POST',{customer_id:id,spec_id:specId,quantity:q,unit_price:price},{'Idempotency-Key':key,'If-Match':current.revision})).data;
          location.href=(native ? 'index.html#' : '/#')+'/pages/outbound/index?order_id='+order.id;
        });
      }
    } catch(e) { notify(e.message); }
  });
  async function start() {
    app.innerHTML='<div class="empty">正在连接客户尺寸本…</div>';
    try { token=(await api('/auth/guest','POST',{})).data.token;state=(await api('/customer-dimensions')).data;render(); }
    catch(e) { app.innerHTML='<div class="empty">'+escaped(e.message)+'<br><button onclick="location.reload()">重新加载</button></div>'; }
  }
  start();
})();
