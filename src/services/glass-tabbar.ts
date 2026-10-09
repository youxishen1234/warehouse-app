// The dock owns its pointer gesture. Page swipes are handled by tab-navigation.
const paths = [
  '<path d="M3 10.5 12 3l9 7.5M5 9v12h5v-6h4v6h5V9"/>',
  '<path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>',
  '<path d="M2.5 16.5v-11h12v11m0-7.5h4l3 4v3.5H20m-5.5-3.5h7M9 16.5h6m-12.5 0H4"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/>',
  '<circle cx="12" cy="6.5" r="3.5"/><path d="M5 21v-2c0-3.5 3-6 7-6s7 2.5 7 6v2"/>'
];
// One 24-unit grid and stroke weight for every tab, including selected copies.
const icon = (index: number) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[index] + '</svg>';
const titles = ['首页', 'AI助手', '出库', '我的'];
// 桌面侧边栏的“业务中心”快捷入口（仅 ≥1024px 显示，手机端 CSS 隐藏）
const bizNav = [
  { title: '纸板库存', path: '/pages/board-stock/index' },
  { title: '客户管理', path: '/pages/customers/index' },
  { title: '订单出库', path: '/pages/orders/index' },
  { title: '账单流水', path: '/pages/ledger/index' },
  { title: '标签打印', path: '/pages/print-center/index' }
];

export function createGlassTabBar(host: HTMLElement, onSelect: (index: number) => void, onNavigate: (url: string) => void) {
  const dock = document.createElement('div');
  dock.className = 'sg-glass-dock';
  dock.innerHTML = '<nav class="sg-glass-rail" aria-label="主导航">' +
    '<div class="sg-glass-items">' + titles.map((title, index) =>
      '<button type="button" class="sg-glass-tab" data-tab="' + index + '">' + icon(index) + '<span>' + title + '</span></button>').join('') + '</div>' +
    '<div class="sg-glass-lens" aria-hidden="true"><div class="sg-glass-refraction"></div><div class="sg-glass-lens-ink"><div class="sg-glass-lens-items">' + titles.map((title, index) =>
      '<div class="sg-glass-tab">' + icon(index) + '<span>' + title + '</span></div>').join('') + '</div></div></div>' +
    '<div class="sg-biz-nav"><div class="sg-biz-title">业务中心</div>' +
    bizNav.map(item => '<button type="button" class="sg-biz-item" data-nav="' + item.path + '"><span>' + item.title + '</span></button>').join('') +
    '</div></nav>';
  // A smooth lens normal map bends actual background pixels (not a stock texture).
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 96;
  const context = canvas.getContext('2d')!;
  const normals = context.createImageData(128, 96);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 128; x++) {
    const nx = (x - 63.5) / 64, ny = (y - 47.5) / 48;
    const radius = Math.sqrt(nx * nx + ny * ny);
    const rim = Math.exp(-Math.pow((radius - .86) / .15, 2));
    const offset = (y * 128 + x) * 4;
    normals.data[offset] = 128 - nx * rim * 110;
    normals.data[offset + 1] = 128 - ny * rim * 110;
    normals.data[offset + 2] = 128; normals.data[offset + 3] = 255;
  }
  context.putImageData(normals, 0, 0);
  const normalMap = '<feImage href="' + canvas.toDataURL() + '" width="100%" height="100%" preserveAspectRatio="none" result="normal"/>';
  // Keep the backdrop filter to one displacement pass: Chromium's backdrop
  // pipeline does not preserve SourceGraphic across separate colour passes.
  const backdropFilter = '<filter id="sg-dock-refraction" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' + normalMap + '<feDisplacementMap in="SourceGraphic" in2="normal" scale="6" xChannelSelector="R" yChannelSelector="G"/></filter>';
  dock.insertAdjacentHTML('beforeend', '<svg class="sg-glass-optics" aria-hidden="true"><defs>' + backdropFilter + '</defs></svg>');
  host.classList.add('sg-glass-host');
  host.appendChild(dock);
  const rail = dock.querySelector<HTMLElement>('.sg-glass-rail')!;
  const lens = dock.querySelector<HTMLElement>('.sg-glass-lens')!;
  const lensItems = dock.querySelector<HTMLElement>('.sg-glass-lens-items')!;
  const baseItems = dock.querySelector<HTMLElement>('.sg-glass-items')!;
  const buttons = Array.from(dock.querySelectorAll<HTMLButtonElement>('button[data-tab]'));
  let selected = 0;
  let position = 0;
  let target = 0;
  let velocity = 0;
  let animation = 0;
  let previousTime = 0;
  let pointer: { id: number; offset: number; left: number; top: number; bottom: number; cancelled: boolean } | null = null;
  let cellWidth = 1;
  let suppressClick = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 1024px)');
  let ripplePosition = 0;
  let rippleTime = -Infinity;
  const ripple = (direction: number) => {
    if (reduced.matches) return;
    const now = performance.now();
    if (now - rippleTime < 180) return;
    rippleTime = now;
    const wave = document.createElement('div');
    wave.className = 'sg-glass-wave';
    lens.prepend(wave);
    const flip = direction < 0 ? -1 : 1;
    const motion = wave.animate([
      { transform: 'translateX(' + (-flip * 38) + 'px) scaleX(' + flip + ')', opacity: 0 },
      { opacity: .45, offset: .25 },
      { transform: 'translateX(' + (flip * 65) + 'px) scaleX(' + flip + ')', opacity: 0 }
    ], { duration: 640, easing: 'cubic-bezier(.2,.6,.35,1)' });
    motion.onfinish = () => wave.remove();
    motion.oncancel = () => wave.remove();
  };
  const clamp = (value: number) => Math.max(0, Math.min(3, value));
  const measure = () => { cellWidth = Math.max(1, (rail.clientWidth - 16) / 4); };
  const render = () => {
    if (desktop.matches) {
      baseItems.style.removeProperty('mask-image');
      baseItems.style.removeProperty('-webkit-mask-image');
      return;
    }
    // Geometry is read on resize / pointerdown, never after every transform
    // write. This avoids synchronous layout work in the finger-follow path.
    const cell = cellWidth;
    if (Math.abs(position - ripplePosition) > .28 && dock.classList.contains('sg-glass-pressed')) {
      ripple(position - ripplePosition);
      ripplePosition = position;
    }
    // Keep the capsule inset and the same size throughout the gesture.
    const expansion = 4;
    lens.style.setProperty('--glass-light', (40 + position / 3 * 20) + '%');
    lens.style.setProperty('--glass-angle', (115 + position * 16) + 'deg');
    lens.style.width = (cell + expansion * 2) + 'px';
    lens.style.transform = 'translate3d(' + (8 + position * cell - expansion) + 'px,0,0)';
    lensItems.style.width = (cell * 4) + 'px';
    lensItems.style.transform = 'translate3d(' + (expansion - position * cell) + 'px,0,0)';
    const left = position * cell - expansion, right = position * cell + cell + expansion;
    const mask = 'linear-gradient(to right, #000 0px, #000 ' + left + 'px, transparent ' + left + 'px, transparent ' + right + 'px, #000 ' + right + 'px)';
    baseItems.style.setProperty('mask-image', mask);
    baseItems.style.setProperty('-webkit-mask-image', mask);
    dock.dataset.position = position.toFixed(4);
  };
  const tick = (time: number) => {
    const dt = Math.min((time - (previousTime || time - 16)) / 1000, .032);
    previousTime = time;
    // Exact critically damped motion stays smooth even when frame times vary.
    const offset = position - target;
    const impulse = velocity + 24 * offset;
    const decay = Math.exp(-24 * dt);
    const next = target + (offset + impulse * dt) * decay;
    velocity = (velocity - 24 * impulse * dt) * decay;
    const bounded = Math.max(Math.min(position, target), Math.min(Math.max(position, target), next));
    if (bounded !== next) velocity = 0;
    position = bounded;
    render();
    if (Math.abs(target - position) > .0005 || Math.abs(velocity) > .005) animation = requestAnimationFrame(tick);
    else { position = target; velocity = 0; animation = 0; render(); }
  };
  const settle = (index: number, immediate = false) => {
    target = clamp(index);
    if (immediate || reduced.matches) {
      cancelAnimationFrame(animation); animation = 0; velocity = 0; position = target; render();
    } else if (!animation) { previousTime = 0; animation = requestAnimationFrame(tick); }
  };
  const update = (index: number, immediate = false) => {
    selected = clamp(index);
    buttons.forEach((button, i) => {
      if (i === selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (!pointer) {
      dock.classList.remove('sg-glass-pressed');
      settle(selected, immediate);
    }
  };
  const down = (event: PointerEvent) => {
    // Desktop tabs are vertical buttons, not cells in the mobile drag rail.
    if (desktop.matches || !(event.target as Element).closest('[data-tab], .sg-glass-lens')) return;
    if (pointer || !event.isPrimary || event.button !== 0) return;
    cancelAnimationFrame(animation); animation = 0; velocity = 0;
    const rect = rail.getBoundingClientRect();
    measure();
    const at = (event.clientX - rect.left - 8) / cellWidth - .5;
    // Preserve the point grabbed on the existing lens; tapping another tab grabs its centre.
    const onLens = Math.abs(at - position) <= .5;
    pointer = { id: event.pointerId, offset: onLens ? at - position : 0, left: rect.left, top: rect.top, bottom: rect.bottom, cancelled: false };
    if (!onLens) position = clamp(at);
    rail.setPointerCapture(event.pointerId);
    dock.classList.add('sg-glass-pressed');
    ripplePosition = position;
    ripple(1);
    render();
  };
  const move = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.cancelled) return;
    if (event.clientY < pointer.top - 48 || event.clientY > pointer.bottom + 48) {
      pointer.cancelled = true;
      dock.classList.remove('sg-glass-pressed');
      settle(selected);
      return;
    }
    position = clamp((event.clientX - pointer.left - 8) / cellWidth - .5 - pointer.offset);
    render();
  };
  const finish = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const cancelled = event.type !== 'pointerup' || pointer.cancelled;
    const index = cancelled ? selected : Math.round(position);
    pointer = null;
    dock.classList.remove('sg-glass-pressed');
    if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId);
    suppressClick = true;
    settle(index);
    if (!cancelled) onSelect(index);
  };
  const click = (event: MouseEvent) => {
    const item = (event.target as Element).closest<HTMLElement>('[data-nav]');
    if (item?.dataset.nav) { onNavigate(item.dataset.nav); return; }
    // Pointer selection commits on release; keyboard/assistive clicks still use this path.
    if (!desktop.matches && event.detail && suppressClick) { suppressClick = false; event.preventDefault(); return; }
    const button = (event.target as Element).closest<HTMLElement>('[data-tab]');
    if (button) { const index = Number(button.dataset.tab); settle(index); onSelect(index); }
  };
  const keydown = (event: KeyboardEvent) => {
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? clamp(index + 1) : event.key === 'ArrowLeft' ? clamp(index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : -1;
    if (next < 0) return;
    event.preventDefault(); buttons[next].focus(); settle(next); onSelect(next);
  };
  rail.addEventListener('pointerdown', down);
  rail.addEventListener('pointermove', move);
  rail.addEventListener('pointerup', finish);
  rail.addEventListener('pointercancel', finish);
  rail.addEventListener('lostpointercapture', finish);
  rail.addEventListener('click', click);
  rail.addEventListener('keydown', keydown);
  const onResize = () => { measure(); render(); };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
  resize?.observe(rail);
  if (!resize) window.addEventListener('resize', onResize);
  measure();
  update(0, true);
  return {
    host,
    update,
    preview(index: number) {
      if (pointer) return;
      dock.classList.add('sg-glass-pressed');
      cancelAnimationFrame(animation); animation = 0; velocity = 0;
      position = clamp(index); render();
    },
    destroy() { cancelAnimationFrame(animation); resize?.disconnect(); window.removeEventListener('resize', onResize); dock.remove(); host.classList.remove('sg-glass-host'); }
  };
}
