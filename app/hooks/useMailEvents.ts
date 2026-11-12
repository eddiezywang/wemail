import { useEffect, useRef } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import { useCurrentAccount } from "~/queries/currentAccount";
import { dispatchMailAuthRequired } from "~/lib/mailCredentialEvents";
import { markAction } from "~/components/dev/RenderTrace";
import { isMarkAllMailReadRunning } from "~/lib/markAllMailRead";
import { recordMailReceiptEvent } from "~/lib/mailReceiptTrace";

interface MailChangedPayload {
  accountId: string;
  origin?: "live-idle" | "live-poll" | "manual";
  insertedCount?: number;
  insertedIds: string[];
}

type MailInvalidationReason =
  | "focus"
  | "visibility"
  | "db-reset"
  | "legacy-event"
  | "web-event";

const FOCUS_REFRESH_GUARD_MS = 60_000;
const FOCUS_REFRESH_COALESCE_MS = 100;
/**
 * A db-event for a detail/list cache that was updated within this window is
 * usually the echo of an optimistic message mutation (for example mark-read).
 * Body commits are different: persistBody writes the content row but does not
 * patch the renderer cache, so content events must bypass this guard.
 */
const DETAIL_RECENCY_SKIP_MS = 2_000;

function invalidateMailboxQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string,
  reason: MailInvalidationReason,
) {
  if (isMarkAllMailReadRunning(accountId)) return;
  if (import.meta.env.DEV) {
    const matchingEmailQueries = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["emails", accountId] })
      .map((query) => ({
        key: query.queryKey,
        fetchStatus: query.state.fetchStatus,
        status: query.state.status,
      }));
    console.debug(
      "[mail-events] invalidate",
      JSON.stringify({
        accountId,
        reason,
        matchingEmailQueries,
      }),
    );
  }
  notifyManager.batch(() => {
    void queryClient.invalidateQueries({
      queryKey: ["emails", accountId],
      predicate: (query) =>
        typeof query.queryKey[2] === "object" && query.queryKey[2] !== null,
      refetchType: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.folders.list(accountId),
      refetchType: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: ["list-categories", accountId],
      refetchType: "active",
    });
  });
}

export function useMailEvents(): void {
  const queryClient = useQueryClient();
  const { data: currentAccount } = useCurrentAccount();
  const accountId = currentAccount?.account?.id;
  const lastDatabaseCommitRef = useRef(0);
  const lastCatchUpRefreshRef = useRef(0);
  const catchUpTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!accountId) return;
    lastDatabaseCommitRef.current = 0;
    const hasRealtimeDatabaseEvents = Boolean(
      window.wemailDesktop?.mailDatabase?.onChanged,
    );

    const onMailChanged = ({
      accountId: changedAccountId,
      insertedCount,
      insertedIds,
    }: MailChangedPayload) => {
      if (import.meta.env.DEV) {
        console.debug(
          "[mail-events] desktop/web event received",
          JSON.stringify({
            changedAccountId,
            currentAccountId: accountId,
          }),
        );
      }
      invalidateMailboxQueries(
        queryClient,
        changedAccountId,
        window.wemailDesktop ? "legacy-event" : "web-event",
      );
    };
    const scheduleCatchUpRefresh = (reason: "focus" | "visibility") => {
      // Electron receives exact DB commit events even while the window is in
      // the background. A focus-wide refetch is both redundant and harmful:
      // the first click after returning to the app would otherwise refresh the
      // entire visible mailbox in the same interaction turn.
      if (hasRealtimeDatabaseEvents) return;
      const now = Date.now();
      if (now - lastCatchUpRefreshRef.current < FOCUS_REFRESH_GUARD_MS) return;
      if (catchUpTimerRef.current !== null) return;
      catchUpTimerRef.current = window.setTimeout(() => {
        catchUpTimerRef.current = null;
        lastCatchUpRefreshRef.current = Date.now();
        invalidateMailboxQueries(queryClient, accountId, reason);
      }, FOCUS_REFRESH_COALESCE_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        markAction("visibility-visible");
        scheduleCatchUpRefresh("visibility");
      }
    };
    const onWindowFocus = () => {
      markAction("window-focus");
      scheduleCatchUpRefresh("focus");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);

    const desktopSubscription = window.wemailDesktop?.onMailChanged;
    const desktopAuthSubscription = window.wemailDesktop?.onMailAuthRequired;
    const databaseSubscription = window.wemailDesktop?.mailDatabase?.onChanged;
    if (desktopSubscription || desktopAuthSubscription || databaseSubscription) {
      // DB Service commit events carry exact entity IDs. Do not also consume
      // the legacy account-wide mail event or every body commit would refetch
      // all visible lists and categories.
      const unsubscribe = databaseSubscription
        ? undefined
        : desktopSubscription?.(onMailChanged);
      const unsubscribeAuth = desktopAuthSubscription?.((payload) => {
        dispatchMailAuthRequired({
          accountId: payload.accountId,
          code: payload.code,
          source: "background",
        });
      });
      const unsubscribeDatabase = databaseSubscription?.((event) => {
        if (event.commitVersion <= lastDatabaseCommitRef.current) return;
        lastDatabaseCommitRef.current = event.commitVersion;
        recordMailReceiptEvent(accountId, event.commitVersion, event.changes.filter((change) =>
          change.entityType === "message" && change.operation === "insert" &&
          (!change.scopeHint || change.scopeHint === `account:${accountId}`),
        ).map((change) => change.entityPublicId));
        markAction("db-event");
        if (event.resetRequired) {
          invalidateMailboxQueries(queryClient, accountId, "db-reset");
          return;
        }
        const detailIds = new Set<string>();
        const bodyDetailIds = new Set<string>();
        const messageDetailIds = new Set<string>();
        const intelligenceIds = new Set<string>();
        let invalidateMailLists = false;
        let invalidateFolders = false;
        let invalidateCategories = false;
        let invalidateScheduled = false;
        for (const change of event.changes) {
          if (change.entityType === "ai_artifact") {
            // AI artifacts (summary / tags / replyDecision / replyDraft) back
            // the *intelligence* query only — they never touch the email row
            // (body / metadata / read flag). Invalidating the detail query on
            // an ai_artifact commit just re-fetches an identical email,
            // returns a new object reference, and forces EmailPanel — plus the
            // memo'd intelligence section, whose memo is defeated by that new
            // email object — to re-render on every artifact the background
            // pipeline writes for the open message (up to 4× per open).
            // Invalidation belongs on the intelligence key alone.
            intelligenceIds.add(change.entityPublicId);
            continue;
          }
          if (change.entityType === "content") {
            detailIds.add(change.entityPublicId);
            bodyDetailIds.add(change.entityPublicId);
            continue;
          }
          if (change.entityType === "attachment") {
            detailIds.add(change.entityPublicId);
            continue;
          }
          if (change.entityType === "message") {
            detailIds.add(change.entityPublicId);
            messageDetailIds.add(change.entityPublicId);
            invalidateMailLists = true;
            if (change.operation === "insert") {
              invalidateFolders = true;
              invalidateCategories = true;
            }
            continue;
          }
          if (change.entityType === "folder") {
            invalidateFolders = true;
          } else if (change.entityType === "category") {
            invalidateCategories = true;
          } else if (change.entityType === "outbox" || change.entityType === "draft") {
            invalidateScheduled = true;
          }
        }
        notifyManager.batch(() => {
          for (const id of detailIds) {
            const detailKey = queryKeys.emails.detail(accountId, id);
            const existing = queryClient
              .getQueryCache()
              .find({ queryKey: detailKey, exact: true });
            const fetchedAt = existing?.state.dataUpdatedAt ?? 0;
            // Skip a recent message-only echo (normally our optimistic
            // mark-read write). A content commit is the opposite: the body was
            // written to SQLite but the renderer cache is still pending, so it
            // must always trigger a targeted local refresh.
            if (
              !bodyDetailIds.has(id) &&
              Date.now() - fetchedAt < DETAIL_RECENCY_SKIP_MS
            ) continue;
            void queryClient.invalidateQueries({
              queryKey: detailKey,
              exact: true,
              refetchType: "active",
            });
          }
          for (const id of intelligenceIds) {
            void queryClient.invalidateQueries({
              queryKey: ["wemail-intelligence", "messages", id],
              exact: true,
              refetchType: "active",
            });
          }
          const recentMessageEcho = messageDetailIds.size > 0 &&
            bodyDetailIds.size === 0 &&
            Array.from(messageDetailIds).every((id) => {
              const existing = queryClient.getQueryCache().find({
                queryKey: queryKeys.emails.detail(accountId, id),
                exact: true,
              });
              const fetchedAt = existing?.state.dataUpdatedAt ?? 0;
              return Date.now() - fetchedAt < DETAIL_RECENCY_SKIP_MS;
            });
          // The optimistic read mutation already patched both the detail and
          // list caches. Consuming its own message echo here would immediately
          // refetch the mailbox and race first body paint, so leave those local
          // caches alone during the same short recency window. External or
          // body-bearing commits still invalidate the list normally.
          // The bulk action refreshes once after settling; per-message echoes
          // otherwise cancel and restart every cached page thousands of times.
          const bulkReadRunning = isMarkAllMailReadRunning(accountId);
          if (invalidateMailLists && !recentMessageEcho && !bulkReadRunning) {
            void queryClient.invalidateQueries({
              queryKey: ["emails", accountId],
              predicate: (query) =>
                typeof query.queryKey[2] === "object" && query.queryKey[2] !== null,
              refetchType: "active",
            });
          }
          if (invalidateFolders && !bulkReadRunning) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.folders.list(accountId),
              refetchType: "active",
            });
          }
          if (invalidateCategories && !bulkReadRunning) {
            void queryClient.invalidateQueries({
              queryKey: ["list-categories", accountId],
              refetchType: "active",
            });
          }
          if (invalidateScheduled) {
            void queryClient.invalidateQueries({
              queryKey: ["scheduled-drafts", accountId],
              refetchType: "active",
            });
          }
        });
      });
      return () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", onWindowFocus);
        unsubscribe?.();
        unsubscribeAuth?.();
        unsubscribeDatabase?.();
        if (catchUpTimerRef.current !== null) {
          window.clearTimeout(catchUpTimerRef.current);
          catchUpTimerRef.current = null;
        }
      };
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
      if (catchUpTimerRef.current !== null) {
        window.clearTimeout(catchUpTimerRef.current);
        catchUpTimerRef.current = null;
      }
    };
  }, [accountId, queryClient]);
}
