const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

export async function retryAccountConfiguration(
  configure: () => Promise<void>,
  isCurrent: () => boolean,
  onRetry: (attempt: number, delayMs: number, error: unknown) => void,
): Promise<boolean> {
  for (let attempt = 0; isCurrent(); attempt++) {
    try {
      await configure();
      return isCurrent();
    } catch (error) {
      if (!isCurrent()) return false;
      const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      onRetry(attempt + 1, delayMs, error);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
