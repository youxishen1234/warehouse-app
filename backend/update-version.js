function isNewerVersion(latest, current) {
  if (!current || current === 'builtin') return /^\d{14}$/.test(latest);
  if (/^\d{14}$/.test(latest) && /^\d{14}$/.test(current)) return latest > current;
  // Unknown or mixed formats cannot establish a safe upgrade order.
  return false;
}
module.exports = { isNewerVersion };
