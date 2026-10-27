export function isNewerVersion(latest: string, current: string): boolean {
  if (!/^\d{14}$/.test(latest)) return false;
  if (!current || current === 'builtin') return true;
  if (/^\d{14}$/.test(current)) return latest > current;
  // App stores can report a semantic build version instead of a timestamp.
  // A published timestamp is newer until the updater switches to its version.
  return /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(current);
}
