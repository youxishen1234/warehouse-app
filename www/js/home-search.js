(function () {
  'use strict';
  var actions = [
    { label: '商品管理', route: '/pages/products/index', aliases: ['商品', '产品', '分类'] },
    { label: '库存查询', route: '/pages/inventory/index', aliases: ['库存', '库存预警', '经营概览', '经营状况', '经营情况'] },
    { label: '客户管理', route: '/pages/customers/index', aliases: ['客户', '客户名称', '客户信息', '电话', '联系人'] },
    { label: '出入库记录', route: '/pages/records/index', aliases: ['记录', '流水', '出入库', '进出库'] },
    { label: '采购入库', route: '/pages/inbound/index', aliases: ['入库', '采购'] },
    { label: '销售出库', route: '/pages/outbound/index', aliases: ['出库', '销售'] }
  ];
  var headerSelector = '[class*="header___"]';
  var pendingKey = 'sg_home_search';
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
    if (query) { try { localStorage.setItem(pendingKey, query); } catch (e) {} }
    clickRoute(route);
  }
  function matchesAction(action, value) {
    var needle = normalize(value);
    if (!needle) return false;
    if (normalize(action.label).indexOf(needle) >= 0) return true;
    return action.aliases.some(function (alias) { return normalize(alias).indexOf(needle) >= 0 || needle.indexOf(normalize(alias)) >= 0; });
  }
  function queryTargets(value) {
    var needle = normalize(value), ranked = actions.filter(function (action) { return matchesAction(action, needle); });
    var order;
    if (/客户|电话|联系人/.test(needle)) order = ['/pages/customers/index', '/pages/records/index', '/pages/outbound/index'];
    else if (/入库|采购/.test(needle)) order = ['/pages/inbound/index', '/pages/records/index', '/pages/products/index'];
    else if (/出库|销售/.test(needle)) order = ['/pages/outbound/index', '/pages/records/index', '/pages/products/index'];
    else if (/库存|经营/.test(needle)) order = ['/pages/inventory/index', '/pages/products/index', '/pages/records/index'];
    else order = ['/pages/products/index', '/pages/customers/index', '/pages/inventory/index', '/pages/records/index'];
    order.forEach(function (route) {
      if (!ranked.some(function (action) { return action.route === route; })) {
        var action = routeAction(route); if (action) ranked.push(action);
      }
    });
    return ranked;
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
    addSearchBar(); enhanceDashboard(); injectPendingSearch();
    new MutationObserver(function () { addSearchBar(); enhanceDashboard(); injectPendingSearch(); }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', injectPendingSearch);
  }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
