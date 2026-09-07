import React from 'react';
import { Image } from '@tarojs/components';

// ============================================
// 矢量图标组件（专业进销存风线性图标）
// 双端兼容：SVG 经 base64 编码为 data URI，
// H5 <img> 与微信小程序 <image> 均原生支持；
// 尺寸由父级 CSS class（rpx）控制，矢量缩放不失真
// ============================================

export type IconName =
  | 'home' | 'inbound' | 'outbound' | 'mine'
  | 'tag' | 'box' | 'money' | 'alert'
  | 'search' | 'clipboard' | 'records' | 'chevron'
  | 'plus' | 'edit' | 'list' | 'clock' | 'trend'
  | 'check' | 'scan' | 'trash' | 'download';

// 24x24 viewBox，stroke 线性图标（与 tabBar 图标同风格）
const ICON_PATHS: Record<IconName, string> = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  // 入库：向下箭头（进货入仓）
  inbound: '<path d="M12 3v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>',
  // 出库：向上箭头（出货出仓）
  outbound: '<path d="M12 21V10"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>',
  mine: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  tag: '<path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.2 12h.01M17.8 12h.01"/>',
  alert: '<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17.5h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V6H9z"/><path d="M9 12h6M9 16h4"/>',
  records: '<path d="M6 2.5h9.5L20 7v14.5H6z"/><path d="M14.5 2.5V7H20"/><path d="M9 12.5h6M9 16.5h4.5"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  trend: '<path d="M3 3v18h18"/><path d="m7 14.5 3.5-4 3 2.5L19 8"/><path d="M15 8h4v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  // 下载：箭头入托盘
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'
};

// 纯 ASCII base64 编码（不依赖 btoa / Buffer，双端可用）
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const c0 = input.charCodeAt(i);
    const has1 = i + 1 < input.length;
    const has2 = i + 2 < input.length;
    const c1 = has1 ? input.charCodeAt(i + 1) : 0;
    const c2 = has2 ? input.charCodeAt(i + 2) : 0;
    out += B64[c0 >> 2];
    out += B64[((c0 & 3) << 4) | (c1 >> 4)];
    out += has1 ? B64[((c1 & 15) << 2) | (c2 >> 6)] : '=';
    out += has2 ? B64[c2 & 63] : '=';
  }
  return out;
}

function buildSvgUri(name: IconName, color: string, strokeWidth: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
  return `data:image/svg+xml;base64,${toBase64(svg)}`;
}

export interface IconProps {
  name: IconName;
  color?: string;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}

const Icon: React.FC<IconProps> = ({ name, color = '#2f6bff', strokeWidth = 2, className, style }) => {
  return (
    <Image
      className={className}
      src={buildSvgUri(name, color, strokeWidth)}
      mode="aspectFit"
      style={{ display: 'block', ...style }}
    />
  );
};

export default Icon;
