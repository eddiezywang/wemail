import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";

/**
 * Coalesce burst invalidations: the DB Service broadcasts a change event on
 * EVERY writer commit (job claim/complete, body persist, AI artifact write),
 * so a busy writer drives a flood of list refetches (mail.list storms that
 * queue the list-a lane past its 2s budget). Batch them into one refetch.
 */
const MAIL_CHANGED_COALESCE_MS = 300;

export function useDesktopMailEvents(): void {
  const queryClient = useQueryClient();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const onMailChanged = window.wemailDesktop?.onMailChanged;
    if (!onMailChanged) return;

    return onMailChanged(({ accountId }) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        queryClient.invalidateQueries({ queryKey: ["emails", accountId] });
        queryClient.invalidateQueries({
          queryKey: queryKeys.folders.list(accountId),
        });
        queryClient.invalidateQueries({
          queryKey: ["list-categories", accountId],
        });
        queryClient.invalidateQueries({
          queryKey: ["agent-suggestions", accountId],
        });
      }, MAIL_CHANGED_COALESCE_MS);
    });
  }, [queryClient]);
}
