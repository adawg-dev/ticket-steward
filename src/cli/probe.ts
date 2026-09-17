/** True when the URL answers at all (any status) within the timeout; false on network error or timeout. */
export const answers = async (fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<boolean> => {
  try {
    await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
};

export const localHealthUrl = (port: number): string => `http://localhost:${port}/health`;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const withTimeout = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
};
