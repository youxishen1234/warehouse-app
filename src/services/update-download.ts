export const UPDATE_DOWNLOAD_ATTEMPTS = 2;
export const UPDATE_DOWNLOAD_RETRY_DELAY = 1500;
export const UPDATE_DOWNLOAD_TIMEOUT = 190000;

export interface DownloadRetryFailure {
  attempt: number;
  maxAttempts: number;
  message: string;
  emptyBundle: boolean;
}

export interface DownloadRetryResult<T> {
  bundle: T | null;
  emptyBundle: boolean;
}

export async function downloadBundleWithRetry<T extends { id?: string } | null>(
  download: (attempt: number) => Promise<T>,
  onFailure: (failure: DownloadRetryFailure) => void,
  wait: (milliseconds: number) => Promise<void> = milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds))
): Promise<DownloadRetryResult<T>> {
  let emptyBundle = false;

  for (let attempt = 1; attempt <= UPDATE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const bundle = await download(attempt);
      if (bundle?.id) return { bundle, emptyBundle: false };
      emptyBundle = true;
      onFailure({
        attempt,
        maxAttempts: UPDATE_DOWNLOAD_ATTEMPTS,
        message: 'empty bundle id',
        emptyBundle: true
      });
    } catch (error) {
      emptyBundle = false;
      onFailure({
        attempt,
        maxAttempts: UPDATE_DOWNLOAD_ATTEMPTS,
        message: error instanceof Error ? error.message : String(error || 'download error'),
        emptyBundle: false
      });
    }

    if (attempt < UPDATE_DOWNLOAD_ATTEMPTS) await wait(UPDATE_DOWNLOAD_RETRY_DELAY);
  }

  return { bundle: null, emptyBundle };
}
