import { installTabNavigation } from '../src/services/tab-navigation';

const native = new URLSearchParams(location.search).get('client') === 'app';
// This customer subpage belongs to Home; all four buttons use the shared dock.
installTabNavigation({
  route: () => '/pages/customer-desk/index',
  activeTab: () => '/pages/home/index',
  switchTab: async route => { location.href = (native ? 'index.html#' : '/#') + route; },
  back: async () => { history.back(); },
  depth: () => 1,
});
