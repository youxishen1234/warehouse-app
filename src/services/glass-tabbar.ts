const icons = [
  '<path d="M3 10.5 12 3l9 7.5M5 9v12h5v-6h4v6h5V9"/>',
  '<path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/>',
  '<path d="m3 8 9-5 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  '<path d="M7 8V3h10v5M5 8h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2Z"/><path d="M7 14h10v6H7z"/>',
  '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>'
];
const titles = ['总台', 'AI助手', '库存', '打印', '我的'];

export function createGlassTabBar(host: HTMLElement, onSelect: (index: number) => void, _onNavigate: (url: string) => void) {
  const dock = document.createElement('nav');
  dock.className = 'sg-app-nav';
  dock.setAttribute('aria-label', '主导航');
  dock.innerHTML = titles.map((title, index) =>
    `<button type="button" data-tab="${index}" aria-label="${title}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[index]}</svg><span>${title}</span></button>`
  ).join('');
  host.classList.add('sg-glass-host');
  host.appendChild(dock);
  const buttons = Array.from(dock.querySelectorAll<HTMLButtonElement>('button'));
  const update = (index: number, _immediate?: boolean) => {
    buttons.forEach((button, value) => {
      button.classList.toggle('sg-app-nav-selected', value === index);
      if (value === index) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  };
  dock.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-tab]');
    if (button) onSelect(Number(button.dataset.tab));
  });
  dock.addEventListener('keydown', event => {
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? Math.min(4, index + 1)
      : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? 4 : -1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next].focus();
    onSelect(next);
  });
  update(0);
  return {
    host,
    update,
    preview(index: number) { update(Math.max(0, Math.min(4, Math.round(index)))); },
    destroy() { dock.remove(); host.classList.remove('sg-glass-host'); }
  };
}
