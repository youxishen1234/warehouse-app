(function () {
  'use strict';

  var headerSelector = '[class*="header___"]';
  function addSearchBar() {
    var header = document.querySelector(headerSelector);
    if (!header || header.querySelector('.sg-home-search')) return;

    var bar = document.createElement('div');
    bar.className = 'sg-home-search';
    bar.innerHTML = '<span class="sg-home-search-icon">⌕</span>' +
      '<input class="sg-home-search-input" type="search" placeholder="搜索商品名称或分类" autocomplete="off" />' +
      '<button class="sg-home-search-submit" type="button">搜索</button>';

    var top = header.querySelector('[class*="headerTop___"]');
    header.insertBefore(bar, top ? top.nextSibling : header.firstChild);

    var input = bar.querySelector('input');
    var submit = bar.querySelector('button');
    var submitSearch = function () {
      var value = input.value.trim();
      if (!value) return;
      try { localStorage.setItem('sg_home_search', value); } catch (e) {}
      // Use the existing in-app route instead of reloading the Capacitor WebView.
      var targets = document.querySelectorAll('taro-text-core, taro-view-core, text, view');
      for (var i = 0; i < targets.length; i += 1) {
        if (targets[i].textContent.trim() === '商品管理' && getComputedStyle(targets[i]).display !== 'none') {
          targets[i].click();
          return;
        }
      }
    };
    submit.addEventListener('click', submitSearch);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') submitSearch();
    });
  }

  function watch() {
    addSearchBar();
    new MutationObserver(function () {
      addSearchBar();
      var value = '';
      try { value = localStorage.getItem('sg_home_search') || ''; } catch (e) {}
      if (!value || !/products/.test(window.location.pathname)) return;
      var productInput = document.querySelector('input[placeholder*="搜索"], input[placeholder*="名称"]');
      if (!productInput || productInput.value === value) return;
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(productInput, value);
      productInput.dispatchEvent(new Event('input', { bubbles: true }));
      try { localStorage.removeItem('sg_home_search'); } catch (e) {}
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch);
})();
