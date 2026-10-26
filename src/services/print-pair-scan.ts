import jsQR from 'jsqr';

const MAX_IMAGE_EDGE = 1600;

async function decodeImage(file: File): Promise<string> {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('照片读取失败，请重新选择二维码图片'));
      image.src = source;
    });
    const ratio = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法读取二维码图片，请重新拍摄');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height);
    if (!result?.data) throw new Error('没有识别到连接二维码，请对准打印电脑的二维码重试');
    return result.data;
  } finally {
    URL.revokeObjectURL(source);
  }
}

/**
 * Opens the mobile camera/photo picker and resolves with its QR contents.
 * An empty string means the user cancelled; decoding errors are surfaced to UI.
 */
export function scanPrintPairQr(): Promise<string> {
  if (typeof document === 'undefined' || !document.body) {
    return Promise.reject(new Error('当前页面无法打开相机，请使用打印连接链接'));
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('capture', 'environment');
    input.setAttribute('aria-label', '拍摄或选择打印连接二维码');
    input.setAttribute('data-print-pair-scan-input', 'true');
    input.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const removeInput = () => {
      input.remove();
      window.removeEventListener('focus', checkPickerClosed);
      if (focusTimer !== undefined) clearTimeout(focusTimer);
    };
    const finish = (value?: string, error?: Error) => {
      if (settled) return;
      settled = true;
      removeInput();
      if (error) reject(error);
      else resolve(value || '');
    };
    // The `cancel` event is not available in every embedded WebView. When the
    // picker closes without a file, restore the button instead of leaving the
    // print screen stuck on a pending scan.
    const checkPickerClosed = () => {
      focusTimer = setTimeout(() => {
        if (!input.files?.length) finish('');
      }, 600);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { finish(''); return; }
      void decodeImage(file).then(value => finish(value)).catch(issue =>
        finish(undefined, issue instanceof Error ? issue : new Error('读取二维码失败，请重试'))
      );
    }, { once: true });
    input.addEventListener('cancel', () => finish(''), { once: true });
    window.addEventListener('focus', checkPickerClosed, { once: true });
    document.body.appendChild(input);
    // Keep this synchronous with the button gesture so iOS and Android allow
    // the capture chooser to open without a separate permission prompt.
    try {
      input.click();
    } catch {
      finish(undefined, new Error('无法打开相机，请改用电脑提供的打印连接链接'));
    }
  });
}
