export interface RemoteLocatorLookup {
  resolveMessageLocator(
    folder: string,
    messageId: string,
  ): Promise<{ uid: number; uidValidity: number } | null>;
}

export async function resolveRemoteLocatorWithRetry(
  provider: RemoteLocatorLookup,
  folder: string,
  messageId: string,
  delaysMs: readonly number[] = [0, 250, 1_000],
  wait: (delayMs: number) => Promise<void> = defaultWait,
): Promise<{ uid: number; uidValidity: number } | null> {
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await wait(delayMs);
    const locator = await provider.resolveMessageLocator(folder, messageId);
    if (locator) return locator;
  }
  return null;
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
