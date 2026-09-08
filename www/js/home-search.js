(function () {
  'use strict';
  var headerSelector = '[class*="header___"]';
  var actions = [
    ['商品管理', '/pages/products/index'], ['库存查询', '/pages/inventory/index'],
    ['客户管理', '/pages/customers/index'], ['出入库记录', '/pages/records/index'],
    ['采购入库', '/pages/inbound/index'], ['销售出库', '/pages/outbound/index']
  ];
  function clickRoute(url) {
    var item = actions.filter(function (a) { return a[1] === url; })[0];
    if (!item) return;
    var nodes = document.querySelectorAll('taro-text-core, taro-view-core, text, view');
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].textContent.trim() === item[0] && getComputedStyle(nodes[i]).display !== 'none') { nodes[i].click(); return; }
    }
  }
  function addSearchBar() {
    var header = document.querySelector(headerSelector);
    if (!header || header.querySelector('.sg-home-search')) return;
    var bar = document.createElement('div'); bar.className = 'sg-home-search';
    bar.innerHTML = '<span class="sg-home-search-icon">⌕</span><input class="sg-home-search-input" type="search" placeholder="搜索功能或商品" autocomplete="off" /><button class="sg-home-search-submit" type="button">搜索</button><div class="sg-home-search-results"></div>';
    var top = header.querySelector('[class*="headerTop___"]'); header.insertBefore(bar, top ? top.nextSibling : header.firstChild);
    var input = bar.querySelector('input'); var results = bar.querySelector('.sg-home-search-results');
    function render() {
      var value = input.value.trim(); results.innerHTML = ''; if (!value) return;
      actions.filter(function (a) { return a[0].indexOf(value) >= 0; }).forEach(function (a) {
        var result = document.createElement('button'); result.type = 'button'; result.className = 'sg-home-search-result'; result.textContent = a[0];
        result.addEventListener('click', function () { results.innerHTML = ''; clickRoute(a[1]); }); results.appendChild(result);
      });
    }
    function submit() { var value = input.value.trim(); if (!value) return; var exact = actions.filter(function (a) { return a[0] === value; })[0]; if (exact) { results.innerHTML = ''; clickRoute(exact[1]); } else render(); }
    input.addEventListener('input', render); input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); }); bar.querySelector('button').addEventListener('click', submit);
  }
  function enhanceDashboard() {
    var links = [['经营概览', '/pages/inventory/index'], ['今日入库', '/pages/inbound/index'], ['今日出库', '/pages/outbound/index'], ['库存预警', '/pages/inventory/index']];
    var nodes = document.querySelectorAll('taro-text-core, taro-view-core');
    links.forEach(function (link) {
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].textContent.trim() !== link[0] || nodes[i].getAttribute('data-sg-link')) continue;
        var target = nodes[i].closest('taro-view-core') || nodes[i];
        target.setAttribute('data-sg-link', link[1]); target.style.cursor = 'pointer';
        target.addEventListener('click', function (e) { if (e.target.closest('.sg-home-search')) return; clickRoute(this.getAttribute('data-sg-link')); });
        break;
      }
    });
  }
  function addPageNav() {
    if (document.querySelector('.sg-page-nav')) {
      var existing = document.querySelector('.sg-page-nav button');
      var back = document.querySelector('.sg-back-btn');
      if (existing) existing.style.visibility = back && getComputedStyle(back).display !== 'none' ? 'hidden' : 'visible';
      return;
    }
    var nav = document.createElement('div'); nav.className = 'sg-page-nav';
    nav.innerHTML = '<button type="button" aria-label="返回">‹</button><button type="button" aria-label="下一个页面">›</button>';
    var buttons = nav.querySelectorAll('button');
    buttons[0].addEventListener('click', function () {
      var back = document.querySelector('.sg-back-btn');
      if (back && getComputedStyle(back).display !== 'none') { back.click(); return; }
      var tabs = document.querySelectorAll('.taro-tabbar__tab'); if (tabs.length) tabs[Math.max(0, tabs.length - 1)].click();
    });
    buttons[1].addEventListener('click', function () {
      var tabs = document.querySelectorAll('.taro-tabbar__tab');
      if (!tabs.length) return;
      var active = document.querySelector('.taro-tabbar__tab--active, .taro-tabbar__tab-selected');
      var index = Array.prototype.indexOf.call(tabs, active); tabs[(index + 1 + tabs.length) % tabs.length].click();
    });
    document.body.appendChild(nav);
    addPageNav();
  }
  function watch() { addSearchBar(); enhanceDashboard(); addPageNav(); new MutationObserver(function () { addSearchBar(); enhanceDashboard(); addPageNav(); }).observe(document.body, { childList: true, subtree: true }); }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
