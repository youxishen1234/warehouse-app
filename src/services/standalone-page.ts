/** Resolve packaged HTML from the same app root as its scripts, including history routes. */
export function standalonePageUrl(filename: string): URL {
  const native = window.location.protocol === 'file:' || (globalThis as any).Capacitor?.isNativePlatform?.();
  const base = new URL(document.baseURI);
  // A history route is not the directory containing the built index.html.
  const pageAt = base.pathname.indexOf('/pages/');
  if (pageAt >= 0) base.pathname = base.pathname.slice(0, pageAt + 1);
  else if (base.pathname.endsWith('/index.html')) base.pathname = base.pathname.slice(0, -'index.html'.length);
  base.search = ''; base.hash = '';
  const target = new URL(filename, base);
  if (native) target.searchParams.set('client', 'app');
  return target;
}
