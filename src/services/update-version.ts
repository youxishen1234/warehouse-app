export function isNewerVersion(latest: string, current: string): boolean {
  if (!current || current === 'builtin') return /^\d{14}$/.test(latest);
  if (/^\d{14}$/.test(latest) && /^\d{14}$/.test(current)) return latest > current;
  return false;
}
