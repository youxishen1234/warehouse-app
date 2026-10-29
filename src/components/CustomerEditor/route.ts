import Taro from '@tarojs/taro';

/** Consume one-shot editor links so cancel/save stays closed after reload. */
export function clearPartyEditorRoute(params: Record<string, string | undefined>, pathname: string) {
  const hadAction = params.edit !== undefined || params.create !== undefined;
  delete params.edit;
  delete params.create;
  if (!hadAction) return;
  if (typeof window !== 'undefined' && window.history?.replaceState) {
    const address = new URL(window.location.href);
    if (address.hash.startsWith('#/')) {
      const route = new URL(address.hash.slice(1), address.origin);
      route.searchParams.delete('edit');
      route.searchParams.delete('create');
      address.hash = route.pathname + route.search;
    } else {
      address.searchParams.delete('edit');
      address.searchParams.delete('create');
    }
    window.history.replaceState(window.history.state, '', address.href);
    return;
  }
  const query = Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value!)).join('&');
  void Taro.redirectTo({ url: pathname + (query ? '?' + query : '') });
}
