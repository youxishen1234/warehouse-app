(() => {
  const app = document.querySelector('.app');
  const store = 'shuguang-dark-design-v1';
  try { const saved = JSON.parse(localStorage.getItem(store) || 'null'); if (saved) { app.innerHTML = saved.html; document.documentElement.style.cssText = saved.style; } } catch (_) {}
  const persist = () => localStorage.setItem(store, JSON.stringify({ html: app.innerHTML, style: document.documentElement.style.cssText }));
  const style = document.createElement('style');
  style.textContent = `body{background:var(--custom-bg,#101319);font-size:var(--custom-font,14px)}.app{background:none}.company{background:var(--custom-card,linear-gradient(140deg,#202630,#191e27))}.blue{background:var(--custom-accent,linear-gradient(135deg,#468cfb,#3566eb))}.design-tools{display:flex;gap:8px;margin:18px 0}.design-tools button{flex:1;font-size:12px}.editor-mask{position:fixed;inset:0;z-index:100;background:#000a;display:flex;align-items:center;justify-content:center;padding:16px}.editor-dialog{background:#202630;color:#eff3fc;border:1px solid #ffffff20;border-radius:20px;padding:22px;width:100%;max-width:400px;max-height:88vh;overflow:auto}.editor-dialog h2{font-size:19px;margin:0 0 18px}.editor-dialog label{display:grid;gap:7px;color:#aebcd2;font-size:12px;margin:13px 0}.editor-dialog input,.editor-dialog select{width:100%;padding:11px;border:1px solid #ffffff20;border-radius:9px;background:#101319;color:#eff3fc;font:inherit}.editor-dialog input[type=color]{height:40px;padding:4px}.editor-actions{display:flex;gap:10px;margin-top:20px}.editor-actions button{flex:1}.spec-name{cursor:pointer}`;
  document.head.appendChild(style);
  const unnamedStyle = document.createElement('style');
  unnamedStyle.textContent = '.spec-name[data-goods=""]{display:none}.spec-name[data-goods=""] + .spec-value{margin-top:0;font-size:26px}.spec-value{cursor:pointer}';
  document.head.appendChild(unnamedStyle);
  // Demonstrate a larger customer list without touching actual customer data.
  const sampleNames = ['华兴包装有限公司', '兴旺食品有限公司', '远达贸易有限公司', '金盛日用品有限公司', '恒丰印刷有限公司', '佳禾农产品有限公司', '新源电器有限公司', '东升五金有限公司', '悦美家居有限公司', '诚鑫物流有限公司', '瑞丰玩具有限公司', '盛达文具有限公司', '永安实业有限公司', '嘉顺商贸有限公司'];
  if (app.querySelectorAll('.company').length < 15) {
    const template = app.querySelectorAll('.company')[1];
    sampleNames.slice(1).forEach((name, i) => {
      if ([...app.querySelectorAll('.company-head strong')].some(item => item.textContent === name)) return;
      const card = template.cloneNode(true);
      card.querySelector('.company-head strong').textContent = name;
      card.querySelector('.spec-name').textContent = '示例规格';
      card.querySelector('.spec-value').innerHTML = (80 + i * 5) + ' × 60<small>cm</small>';
      app.querySelector('.footer').before(card);
    });
  }
  app.querySelectorAll('.company').forEach(card => card.classList.add('collapsed'));
  const summaryNumber = app.querySelector('.number');
  const refreshCounts = () => {
    summaryNumber.innerHTML = app.querySelectorAll('.company').length + '<small>家公司</small>';
    app.querySelector('.stats strong').textContent = app.querySelectorAll('.spec').length;
  };
  refreshCounts();
  document.addEventListener('click', e => {
    const heading = e.target.closest('.company-head');
    if (!heading || e.target.closest('strong')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const card = heading.closest('.company'), opening = card.classList.contains('collapsed');
    app.querySelectorAll('.company').forEach(item => item.classList.add('collapsed'));
    if (opening) card.classList.remove('collapsed');
  }, true);
  const tools = document.createElement('div'); tools.className = 'design-tools';
  tools.innerHTML = '<button data-design="settings">自定义界面</button><button data-design="reset">恢复示例</button>';
  app.querySelector('.sub').after(tools);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function dialog(title, fields, save) {
    const mask = document.createElement('div'); mask.className = 'editor-mask';
    mask.innerHTML = '<form class="editor-dialog"><h2>' + escape(title) + '</h2>' + fields.map(f => '<label>' + escape(f.label) + '<input name="' + f.key + '" type="' + (f.type || 'text') + '" value="' + escape(f.value || '') + '" ' + (f.required ? 'required' : '') + ' maxlength="100"></label>').join('') + '<div class="editor-actions"><button type="button" data-close>取消</button><button class="blue" type="submit">保存修改</button></div></form>';
    document.body.appendChild(mask);
    mask.querySelector('[data-close]').onclick = () => mask.remove();
    mask.querySelector('form').onsubmit = e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target)); if (fields.some(f => f.required && !String(data[f.key] || '').trim())) return; save(data); mask.remove(); persist(); };
  }
  function editSpec(spec, company) {
    const value = spec?.querySelector('.spec-value');
    dialog(spec ? '编辑货物和规格' : '添加常用规格', [
      { key:'goods', label:'货物名称（选填，没有名字可留空）', value:spec?.querySelector('.spec-name')?.dataset.goods ?? spec?.querySelector('.spec-name')?.textContent },
      { key:'size', label:'规格尺寸', value:value?.childNodes[0]?.textContent?.trim(), required:true },
      { key:'sizeUnit', label:'尺寸单位', value:value?.querySelector('small')?.textContent || 'cm', required:true },
      { key:'material', label:'材质', value:spec?.querySelector('.meta')?.textContent.split(' · ')[0] || '五层 AB 楞', required:true },
      { key:'unit', label:'数量单位', value:spec?.querySelector('.controls span')?.textContent || '个', required:true }
    ], d => {
      if (!spec) { spec = document.createElement('div'); spec.className = 'spec'; company.querySelector('.new-spec').before(spec); }
      spec.innerHTML = '<div class="spec-name" data-goods="' + escape(d.goods.trim()) + '">' + escape(d.goods.trim() || '按规格识别') + '</div><div class="spec-value">' + escape(d.size) + '<small>' + escape(d.sizeUnit) + '</small></div><div class="meta">' + escape(d.material) + ' · 单位：' + escape(d.unit) + '</div><div class="controls"><label>本次数量</label><input type="number" min="1" placeholder="填数量" aria-label="本次数量"><span>' + escape(d.unit) + '</span></div><div class="actions"><button>打印标签</button><button class="blue">出库发货 →</button></div><div class="minor"><span>货物名称可留空，以规格识别</span><button>修改规格</button></div>';
    });
  }
  function editCompany(company) {
    dialog(company ? '编辑公司' : '新增公司', [{ key:'name', label:'公司名称', value:company?.querySelector('.company-head strong')?.textContent, required:true }], d => {
      if (company) company.querySelector('.company-head strong').textContent = d.name;
      else { const section = document.createElement('section'); section.className = 'company'; section.innerHTML = '<div class="company-head"><div><strong>' + escape(d.name) + '</strong><p>常用货物与规格</p></div><span class="tag">展开 / 收起 ⌄</span></div><div class="specs"><button class="new-spec">＋ 添加这家公司的规格</button></div>'; app.querySelector('.footer').before(section); }
    });
  }
  document.addEventListener('click', e => {
    if (e.target.closest('.editor-mask')) return;
    const target = e.target.closest('button,.spec-name,.spec-value,.company-head strong'); if (!target) return;
    const company = target.closest('.company'), spec = target.closest('.spec');
    const text = target.textContent;
    const action = target.dataset.design;
    if (!action && !text.includes('修改规格') && !target.matches('.spec-name,.spec-value,.company-head strong') && !text.includes('添加这家公司') && !text.includes('＋ 公司')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (action === 'reset') { if (confirm('恢复示例会清除本地预览中的修改，继续吗？')) { localStorage.removeItem(store); location.reload(); } return; }
    if (action === 'settings') {
      dialog('自定义界面', [{key:'title',label:'页面标题',value:app.querySelector('h1').textContent,required:true},{key:'accent',label:'按钮颜色',type:'color',value:'#468cfb'},{key:'bg',label:'页面背景',type:'color',value:'#101319'},{key:'card',label:'卡片背景',type:'color',value:'#202630'}], d => { app.querySelector('h1').textContent=d.title; document.documentElement.style.setProperty('--custom-accent',d.accent); document.documentElement.style.setProperty('--custom-bg',d.bg); document.documentElement.style.setProperty('--custom-card',d.card); }); return;
    }
    if (spec) editSpec(spec, company);
    else if (text.includes('添加这家公司')) editSpec(null, company);
    else editCompany(company);
  }, true);
  document.addEventListener('input', e => { if (e.target.matches('.controls input')) { e.target.setAttribute('value',e.target.value); persist(); } });
  const footer = app.querySelector('.footer'); footer.textContent = '可编辑预览 · 点击公司名修改公司，点击货物名称修改规格。修改保存在本机浏览器，不写入正式库存。';
})();
