(function () {
  'use strict';
  var actions = [
    { label: '商品管理', route: '/pages/products/index', aliases: ['商品', '产品', '分类'] },
    { label: '库存查询', route: '/pages/inventory/index', aliases: ['库存', '库存预警', '经营概览', '经营状况', '经营情况'] },
    { label: '客户管理', route: '/pages/customers/index', aliases: ['客户', '客户名称', '客户信息', '电话', '联系人'] },
    { label: '出入库记录', route: '/pages/records/index', aliases: ['记录', '流水', '出入库', '进出库'] },
    { label: '采购入库', route: '/pages/inbound/index', aliases: ['入库', '采购'] },
    { label: '销售出库', route: '/pages/outbound/index', aliases: ['出库', '销售'] },
    { label: '瓦楞计算', route: '__corrugated_calculator__', aliases: ['瓦楞', '内径', '外径', '卷径', '卷料'] }
  ];
  var headerSelector = '[class*="header___"]';
  var pendingKey = 'sg_home_search';
  var corrugatedRoute = '__corrugated_calculator__';
  var corrugatedModal = null;
  function normalize(value) { return String(value || '').trim().toLowerCase(); }
  function visible(element) {
    if (!element || !element.isConnected) return false;
    var style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }
  function routeAction(route) {
    for (var i = 0; i < actions.length; i += 1) if (actions[i].route === route) return actions[i];
    return null;
  }
  function clickRoute(route) {
    if (route === corrugatedRoute) {
      openCorrugatedCalculator();
      return true;
    }
    var action = routeAction(route);
    if (!action) return false;
    var nodes = document.querySelectorAll('taro-text-core, taro-view-core, text, view');
    for (var i = 0; i < nodes.length; i += 1) {
      if (!visible(nodes[i]) || nodes[i].textContent.trim() !== action.label) continue;
      nodes[i].click();
      return true;
    }
    return false;
  }
  function rememberAndOpen(route, query) {
    if (query && route !== corrugatedRoute) { try { localStorage.setItem(pendingKey, query); } catch (e) {} }
    clickRoute(route);
  }
  function matchesAction(action, value) {
    var needle = normalize(value);
    if (!needle) return false;
    if (normalize(action.label).indexOf(needle) >= 0) return true;
    return action.aliases.some(function (alias) { return normalize(alias).indexOf(needle) >= 0 || needle.indexOf(normalize(alias)) >= 0; });
  }
  function queryTargets(value) {
    var needle = normalize(value), matched = actions.filter(function (action) { return matchesAction(action, needle); });
    var order;
    if (matched.some(function (action) { return action.route === corrugatedRoute; })) order = [corrugatedRoute, '/pages/products/index', '/pages/inventory/index'];
    else if (/客户|电话|联系人/.test(needle)) order = ['/pages/customers/index', '/pages/records/index', '/pages/outbound/index'];
    else if (/入库|采购/.test(needle)) order = ['/pages/inbound/index', '/pages/records/index', '/pages/products/index'];
    else if (/出库|销售/.test(needle)) order = ['/pages/outbound/index', '/pages/records/index', '/pages/products/index'];
    else if (/库存|经营/.test(needle)) order = ['/pages/inventory/index', '/pages/products/index', '/pages/records/index'];
    else order = ['/pages/products/index', '/pages/customers/index', '/pages/inventory/index', '/pages/records/index'];
    var ranked = [];
    order.forEach(function (route) {
      var action = routeAction(route);
      if (action && (matched.some(function (item) { return item.route === route; }) || ranked.length === 0)) ranked.push(action);
    });
    matched.forEach(function (action) { if (!ranked.some(function (item) { return item.route === action.route; })) ranked.push(action); });
    order.forEach(function (route) {
      var action = routeAction(route); if (action && !ranked.some(function (item) { return item.route === route; })) ranked.push(action);
    });
    return ranked;
  }
  function formatCalcNumber(value, decimals) {
    if (!isFinite(value)) return '';
    var fixed = Number(value.toFixed(decimals));
    return String(fixed);
  }
  function openCorrugatedCalculator() {
    if (corrugatedModal && corrugatedModal.isConnected) return;
    var overlay = document.createElement('div');
    overlay.className = 'sg-calc-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = '<section class="sg-calc-dialog" role="dialog" aria-modal="true" aria-labelledby="sg-calc-title">' +
      '<header class="sg-calc-header"><div><h2 id="sg-calc-title">瓦楞卷径计算</h2><p>输入四项中的任意三项</p></div><button class="sg-calc-close" type="button" aria-label="关闭">×</button></header>' +
      '<div class="sg-calc-fields">' +
      '<label class="sg-calc-field"><span>内径 Di <em>mm</em></span><input data-field="inner" type="number" min="0" step="0.01" inputmode="decimal" placeholder="例如 76" /></label>' +
      '<label class="sg-calc-field"><span>外径 Do <em>mm</em></span><input data-field="outer" type="number" min="0" step="0.01" inputmode="decimal" placeholder="例如 500" /></label>' +
      '<label class="sg-calc-field"><span>瓦楞厚度 t <em>mm</em></span><input data-field="thickness" type="number" min="0" step="0.01" inputmode="decimal" placeholder="例如 3" /></label>' +
      '<label class="sg-calc-field"><span>展开长度 L <em>m</em></span><input data-field="length" type="number" min="0" step="0.01" inputmode="decimal" placeholder="例如 200" /></label>' +
      '<label class="sg-calc-field sg-calc-field-wide"><span>卷宽（可选） <em>mm</em></span><input data-field="width" type="number" min="0" step="0.01" inputmode="decimal" placeholder="用于估算体积" /></label>' +
      '</div>' +
      '<div class="sg-calc-actions"><button class="sg-calc-reset" type="button" data-action="reset">清空</button><button class="sg-calc-submit" type="button" data-action="calculate">计算</button></div>' +
      '<div class="sg-calc-message" data-message role="status"></div>' +
      '<div class="sg-calc-result" data-result hidden></div>' +
      '</section>';
    document.body.appendChild(overlay);
    corrugatedModal = overlay;
    var dialog = overlay.querySelector('.sg-calc-dialog');
    var inputs = {
      inner: overlay.querySelector('[data-field="inner"]'),
      outer: overlay.querySelector('[data-field="outer"]'),
      thickness: overlay.querySelector('[data-field="thickness"]'),
      length: overlay.querySelector('[data-field="length"]'),
      width: overlay.querySelector('[data-field="width"]')
    };
    var message = overlay.querySelector('[data-message]');
    var resultBox = overlay.querySelector('[data-result]');
    function setMessage(text, isError) {
      message.textContent = text || '';
      message.classList.toggle('sg-calc-message-error', !!isError);
    }
    function readValue(input) {
      var raw = input.value.trim();
      if (!raw) return null;
      var value = Number(raw);
      return isFinite(value) && value > 0 ? value : NaN;
    }
    function reset() {
      Object.keys(inputs).forEach(function (key) { inputs[key].value = ''; inputs[key].classList.remove('sg-calc-derived'); inputs[key].removeAttribute('aria-invalid'); });
      setMessage('', false);
      resultBox.hidden = true;
      resultBox.innerHTML = '';
    }
    function calculate() {
      var values = {
        inner: readValue(inputs.inner),
        outer: readValue(inputs.outer),
        thickness: readValue(inputs.thickness),
        length: readValue(inputs.length),
        width: readValue(inputs.width)
      };
      var required = ['inner', 'outer', 'thickness', 'length'];
      var missing = required.filter(function (key) { return values[key] === null; });
      var invalid = required.filter(function (key) { return values[key] !== null && isNaN(values[key]); });
      if (values.width !== null && isNaN(values.width)) invalid.push('width');
      Object.keys(inputs).forEach(function (key) { inputs[key].removeAttribute('aria-invalid'); });
      invalid.forEach(function (key) { inputs[key].setAttribute('aria-invalid', 'true'); });
      if (invalid.length) { setMessage('请输入大于 0 的数字。', true); resultBox.hidden = true; return; }
      if (missing.length !== 1) { setMessage('请在内径、外径、厚度、展开长度中留空一项。', true); resultBox.hidden = true; return; }
      var missingKey = missing[0], pi = Math.PI, lengthMm;
      if (missingKey === 'length') {
        if (values.outer <= values.inner) { setMessage('外径必须大于内径。', true); resultBox.hidden = true; return; }
        lengthMm = pi * (values.outer * values.outer - values.inner * values.inner) / (4 * values.thickness);
        values.length = lengthMm / 1000;
      } else if (missingKey === 'thickness') {
        if (values.outer <= values.inner) { setMessage('外径必须大于内径。', true); resultBox.hidden = true; return; }
        lengthMm = values.length * 1000;
        values.thickness = pi * (values.outer * values.outer - values.inner * values.inner) / (4 * lengthMm);
      } else if (missingKey === 'outer') {
        lengthMm = values.length * 1000;
        values.outer = Math.sqrt(values.inner * values.inner + 4 * lengthMm * values.thickness / pi);
      } else {
        lengthMm = values.length * 1000;
        var square = values.outer * values.outer - 4 * lengthMm * values.thickness / pi;
        if (square <= 0) { setMessage('当前长度和厚度超过外径可容纳范围。', true); resultBox.hidden = true; return; }
        values.inner = Math.sqrt(square);
      }
      if (values.outer <= values.inner) { setMessage('计算结果要求外径大于内径。', true); resultBox.hidden = true; return; }
      inputs[missingKey].value = formatCalcNumber(values[missingKey], missingKey === 'length' ? 3 : 2);
      inputs[missingKey].classList.add('sg-calc-derived');
      var radial = (values.outer - values.inner) / 2;
      var areaMm2 = pi * (values.outer * values.outer - values.inner * values.inner) / 4;
      var detail = '<div class="sg-calc-result-heading">计算结果 <span>已补全 ' + ({ inner: '内径', outer: '外径', thickness: '厚度', length: '长度' }[missingKey]) + '</span></div>' +
        '<div class="sg-calc-result-grid"><div><small>内径</small><strong>' + formatCalcNumber(values.inner, 2) + ' <i>mm</i></strong></div>' +
        '<div><small>外径</small><strong>' + formatCalcNumber(values.outer, 2) + ' <i>mm</i></strong></div>' +
        '<div><small>瓦楞厚度</small><strong>' + formatCalcNumber(values.thickness, 2) + ' <i>mm</i></strong></div>' +
        '<div><small>展开长度</small><strong>' + formatCalcNumber(values.length, 3) + ' <i>m</i></strong></div></div>' +
        '<div class="sg-calc-result-meta"><span>径向料厚 <b>' + formatCalcNumber(radial, 2) + ' mm</b></span><span>环形截面积 <b>' + formatCalcNumber(areaMm2 / 100, 2) + ' cm²</b></span>';
      if (values.width !== null) detail += '<span>卷料体积 <b>' + formatCalcNumber(areaMm2 * values.width / 1000000000, 4) + ' m³</b></span>';
      detail += '</div>';
      resultBox.innerHTML = detail;
      resultBox.hidden = false;
      setMessage('计算完成，可修改数值后重新计算。', false);
    }
    overlay.querySelector('.sg-calc-close').addEventListener('click', closeCorrugatedCalculator);
    overlay.querySelector('[data-action="reset"]').addEventListener('click', reset);
    overlay.querySelector('[data-action="calculate"]').addEventListener('click', calculate);
    overlay.addEventListener('click', function (event) { if (event.target === overlay) closeCorrugatedCalculator(); });
    overlay._sgEscape = function (event) { if (event.key === 'Escape') closeCorrugatedCalculator(); };
    document.addEventListener('keydown', overlay._sgEscape);
    dialog.addEventListener('click', function (event) { event.stopPropagation(); });
    inputs.inner.focus();
  }
  function closeCorrugatedCalculator() {
    if (!corrugatedModal) return;
    if (corrugatedModal._sgEscape) document.removeEventListener('keydown', corrugatedModal._sgEscape);
    corrugatedModal.remove();
    corrugatedModal = null;
  }
  function addCorrugatedLauncher() {
    var grid = document.querySelector('[class*="funcGrid___"]');
    if (!grid || grid.querySelector('.sg-corrugated-item')) return;
    var item = document.createElement('div');
    item.className = 'sg-corrugated-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', '打开瓦楞卷径计算');
    item.innerHTML = '<span class="sg-corrugated-icon" aria-hidden="true">卷</span><span class="sg-corrugated-text">瓦楞计算</span>';
    item.addEventListener('click', function () { openCorrugatedCalculator(); });
    item.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCorrugatedCalculator(); } });
    grid.appendChild(item);
  }
  function addSearchBar() {
    var header = document.querySelector(headerSelector);
    if (!header || header.querySelector('.sg-home-search')) return;
    var bar = document.createElement('div');
    bar.className = 'sg-home-search';
    bar.innerHTML = '<span class="sg-home-search-icon" aria-hidden="true">⌕</span><input class="sg-home-search-input" type="search" placeholder="搜索功能、商品或客户" autocomplete="off" /><button class="sg-home-search-submit" type="button">搜索</button><div class="sg-home-search-results" role="listbox"></div>';
    var top = header.querySelector('[class*="headerTop___"]');
    header.insertBefore(bar, top ? top.nextSibling : header.firstChild);
    var input = bar.querySelector('.sg-home-search-input'), results = bar.querySelector('.sg-home-search-results');
    function render() {
      var value = input.value.trim(); results.innerHTML = ''; if (!value) return;
      queryTargets(value).slice(0, 5).forEach(function (action, index) {
        var result = document.createElement('button'); result.type = 'button'; result.className = 'sg-home-search-result'; result.setAttribute('role', 'option');
        result.textContent = index === 0 && matchesAction(action, value) ? action.label : '搜索“' + value + '” · ' + action.label;
        result.addEventListener('click', function () { results.innerHTML = ''; rememberAndOpen(action.route, value); });
        results.appendChild(result);
      });
    }
    function submit() {
      var value = input.value.trim(); if (!value) return;
      var exact = actions.filter(function (action) { return normalize(action.label) === normalize(value); })[0];
      if (exact) { results.innerHTML = ''; rememberAndOpen(exact.route, ''); } else render();
    }
    input.addEventListener('input', render);
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit(); });
    bar.querySelector('.sg-home-search-submit').addEventListener('click', submit);
  }
  function setInputValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function injectPendingSearch() {
    var query = ''; try { query = localStorage.getItem(pendingKey) || ''; } catch (e) {}
    if (!query || !location.hash) return;
    var hash = location.hash, selector = '';
    if (hash.indexOf('/pages/products/') >= 0) selector = 'input[placeholder*="名称"], input[placeholder*="分类"]';
    else if (hash.indexOf('/pages/customers/') >= 0) selector = 'input[placeholder*="客户名"], input[placeholder*="电话"], input[placeholder*="联系人"]';
    else if (hash.indexOf('/pages/inbound/') >= 0 || hash.indexOf('/pages/outbound/') >= 0) selector = 'input[placeholder*="商品名称"], input[placeholder*="分类"]';
    else if (hash.indexOf('/pages/records/') >= 0) selector = 'input[placeholder*="商品名"], input[placeholder*="客户名"]';
    else if (hash.indexOf('/pages/inventory/') >= 0) selector = 'input[placeholder*="名称"], input[placeholder*="分类"]';
    if (!selector) return;
    var inputs = document.querySelectorAll(selector);
    for (var i = 0; i < inputs.length; i += 1) {
      if (!visible(inputs[i]) || inputs[i].classList.contains('sg-home-search-input')) continue;
      setInputValue(inputs[i], query); try { localStorage.removeItem(pendingKey); } catch (e) {} return;
    }
  }
  function enhanceDashboard() {
    var links = [['经营概览', '/pages/inventory/index'], ['今日入库', '/pages/inbound/index'], ['今日出库', '/pages/outbound/index'], ['库存预警', '/pages/inventory/index']];
    var nodes = document.querySelectorAll('taro-text-core, taro-view-core');
    links.forEach(function (link) {
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].textContent.trim() !== link[0] || nodes[i].getAttribute('data-sg-link')) continue;
        var target = nodes[i].closest('taro-view-core') || nodes[i]; target.setAttribute('data-sg-link', link[1]); target.style.cursor = 'pointer';
        target.addEventListener('click', function (event) { if (event.target.closest('.sg-home-search')) return; clickRoute(this.getAttribute('data-sg-link')); }); break;
      }
    });
  }
  function watch() {
    addSearchBar(); enhanceDashboard(); addCorrugatedLauncher(); injectPendingSearch();
    new MutationObserver(function () { addSearchBar(); enhanceDashboard(); addCorrugatedLauncher(); injectPendingSearch(); }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', injectPendingSearch);
    installSwipeNavigation();
  }
  function installSwipeNavigation() {
    var startX = 0, startY = 0, tracking = false;
    document.addEventListener('touchstart', function (event) {
      if (!event.touches || event.touches.length !== 1) return;
      var target = event.target;
      if (target.closest('input, textarea, select, button, a, .weui-tabbar')) { tracking = false; return; }
      startX = event.touches[0].clientX; startY = event.touches[0].clientY; tracking = true;
    }, { passive: true });
    document.addEventListener('touchend', function (event) {
      if (!tracking || !event.changedTouches || !event.changedTouches.length) return;
      tracking = false;
      var end = event.changedTouches[0], dx = end.clientX - startX, dy = end.clientY - startY;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.weui-tabbar__item')).filter(visible);
      if (tabs.length < 2) return;
      var active = document.querySelector('.weui-tabbar__item.weui-bar__item_on');
      var index = Math.max(0, tabs.indexOf(active));
      var next = dx < 0 ? index + 1 : index - 1;
      if (next >= 0 && next < tabs.length) tabs[next].click();
    }, { passive: true });
  }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
