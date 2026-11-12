const pending = new Map<string, Map<number, { receivedAt: number; ids: Set<string> }>>();

export function hasPendingMailReceiptTrace(accountId: string): boolean {
  return pending.has(accountId);
}

export function recordMailReceiptEvent(accountId: string, commitVersion: number, ids: string[]): void {
  if (ids.length === 0) return;
  let commits = pending.get(accountId);
  if (!commits) {
    commits = new Map();
    pending.set(accountId, commits);
  }
  const receivedAt = Date.now();
  commits.set(commitVersion, { receivedAt, ids: new Set(ids.slice(0, 50)) });
  while (commits.size > 32) commits.delete(commits.keys().next().value!);
  while (pending.size > 4) pending.delete(pending.keys().next().value!);
  console.debug("[mail-receipt]", { stage: "event-delivered", commitVersion, at: receivedAt });
}

export function recordMailReceiptPaint(accountId: string, ids: string[], dataUpdatedAt: number): void {
  const commits = pending.get(accountId);
  if (!commits) return;
  const visible = new Set(ids);
  for (const [commitVersion, trace] of commits) {
    if (dataUpdatedAt < trace.receivedAt || ![...trace.ids].some((id) => visible.has(id))) continue;
    console.debug("[mail-receipt]", {
      stage: "list-painted", commitVersion, at: Date.now(), eventToPaintMs: Date.now() - trace.receivedAt,
    });
    commits.delete(commitVersion);
  }
  if (commits.size === 0) pending.delete(accountId);
}
