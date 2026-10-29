import type { CSSProperties } from 'react';

export type ChatIconName = 'back' | 'more' | 'voice' | 'keyboard' | 'smile' | 'plus' | 'photo' | 'camera' | 'file' | 'tools' | 'settings' | 'new' | 'close' | 'mic' | 'person' | 'assistant' | 'play';
const paths: Record<ChatIconName, JSX.Element> = {
  back: <path d='m15 4-8 8 8 8' />,
  more: <><circle cx='5' cy='12' r='1.5' fill='currentColor' stroke='none' /><circle cx='12' cy='12' r='1.5' fill='currentColor' stroke='none' /><circle cx='19' cy='12' r='1.5' fill='currentColor' stroke='none' /></>,
  voice: <><circle cx='12' cy='12' r='10' /><path d='M9 9a4.2 4.2 0 0 1 0 6m3-9a8.2 8.2 0 0 1 0 12m3-15a12.2 12.2 0 0 1 0 18' /></>,
  keyboard: <><rect x='2' y='5' width='20' height='14' rx='2' /><path d='M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10' /></>,
  smile: <><circle cx='12' cy='12' r='10' /><path d='M7 14a5.5 5.5 0 0 0 10 0' /><circle cx='8' cy='9' r='1' fill='currentColor' stroke='none' /><circle cx='16' cy='9' r='1' fill='currentColor' stroke='none' /></>,
  plus: <><circle cx='12' cy='12' r='10' /><path d='M6 12h12M12 6v12' /></>,
  photo: <><rect x='3' y='3' width='18' height='18' rx='2' /><circle cx='8' cy='8' r='1.5' /><path d='m4 18 6-7 4 4 3-3 4 5' /></>,
  camera: <><path d='M8 5 9.5 3h5L16 5h4a2 2 0 0 1 2 2v12H2V7a2 2 0 0 1 2-2z' /><circle cx='12' cy='12' r='4' /></>,
  file: <><path d='M5 2h9l5 5v15H5zM14 2v6h5' /><path d='M9 12h6M9 16h6' /></>,
  tools: <><rect x='3' y='3' width='7' height='7' rx='1' /><rect x='14' y='3' width='7' height='7' rx='1' /><rect x='3' y='14' width='7' height='7' rx='1' /><rect x='14' y='14' width='7' height='7' rx='1' /></>,
  settings: <><path d='m10 3 .5-1h3L14 3l2 1 2-.2 1.5 2.6L18.5 8v3l1 1.5-1.5 2.6-2-.1-2 1-.5 2h-3L10 16l-2-1-2 .1-1.5-2.6 1-1.5V8l-1-1.6L6 3.8l2 .2z' transform='translate(0 2)' /><circle cx='12' cy='11' r='3' transform='translate(0 2)' /></>,
  new: <><path d='M20 11v9H4V4h9M15 3l6 6M10 15l1-5 7-7 4 4-7 7z' /></>,
  close: <path d='m5 5 14 14M5 19 19 5' />,
  mic: <><rect x='8' y='2' width='8' height='13' rx='4' /><path d='M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8' /></>,
  person: <><circle cx='12' cy='8' r='4' /><path d='M4 22v-2a8 8 0 0 1 16 0v2' /></>,
  assistant: <><rect x='3' y='6' width='18' height='15' rx='4' /><path d='M12 2v4M7 12h1m8 0h1M8 17h8' /><circle cx='12' cy='2' r='1' /></>,
  play: <path d='m9 5 9 7-9 7z' fill='currentColor' stroke='none' />
};
export default function ChatIcon({ name, className, style }: { name: ChatIconName; className?: string; style?: CSSProperties }) {
  return <svg className={className} style={style} viewBox='0 0 24 24' width='24' height='24' fill='none' stroke='currentColor' strokeWidth='1.7' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>{paths[name]}</svg>;
}
