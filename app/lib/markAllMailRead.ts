import api from "~/services/api";

const runningAccounts = new Set<string>();

export function isMarkAllMailReadRunning(accountId: string): boolean {
  return runningAccounts.has(accountId);
}

export async function markAllMailRead(
  mailboxId: string,
  scope: Record<string, string>,
  onProgress: (completed: number, total: number) => void,
  signal?: AbortSignal,
) {
  if (runningAccounts.has(mailboxId)) throw new Error("mail-read-batch-already-running");
  runningAccounts.add(mailboxId);
  try {
    return await runMarkAllMailRead(mailboxId, scope, onProgress, signal);
  } finally {
    runningAccounts.delete(mailboxId);
  }
}

async function runMarkAllMailRead(
  mailboxId: string,
  scope: Record<string, string>,
  onProgress: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ marked: number; failed: number; stopped?: true; remaining?: number }> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // Collect the unread snapshot before changing flags invalidates its cursors.
  while (true) {
    if (signal?.aborted) return { marked: 0, failed: 0, stopped: true };
    const params = { ...scope, unread: "1", limit: "500", ...(cursor ? { cursor } : {}) };
    let page: Awaited<ReturnType<typeof api.listEmails>>;
    try {
      page = await (signal ? api.listEmails(mailboxId, params, { signal }) : api.listEmails(mailboxId, params));
    } catch (error) {
      if (signal?.aborted) return { marked: 0, failed: 0, stopped: true };
      throw error;
    }
    if (signal?.aborted) return { marked: 0, failed: 0, stopped: true };
    for (const email of page.emails) if (!email.read) ids.add(email.id);
    if (!page.hasMore) break;
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("mail-read-pagination-incomplete");
    cursor = page.nextCursor;
    cursors.add(cursor);
  }
  const messages = [...ids];
  let marked = 0;
  let failed = 0;
  onProgress(0, messages.length);
  for (let index = 0; index < messages.length; index += 4) {
    if (signal?.aborted) return { marked, failed, stopped: true, remaining: messages.length - marked - failed };
    // Submitted writes must settle so cancellation never misreports their outcomes.
    const results = await Promise.allSettled(messages.slice(index, index + 4).map((id) => api.updateEmail(mailboxId, id, { read: true })));
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) marked++;
      else failed++;
    }
    onProgress(marked + failed, messages.length);
  }
  return { marked, failed };
}
