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
  function watch() { addSearchBar(); new MutationObserver(addSearchBar).observe(document.body, { childList: true, subtree: true }); }
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
})();
