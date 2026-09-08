(function () {
  'use strict';

  var headerSelector = '[class*="header___"]';
  var baseUrl = 'https://youxishen.online';

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
      window.location.href = '/pages/products/index?keyword=' + encodeURIComponent(value);
    };
    submit.addEventListener('click', submitSearch);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') submitSearch();
    });
  }

  function watch() {
    addSearchBar();
    new MutationObserver(addSearchBar).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch);
})();
