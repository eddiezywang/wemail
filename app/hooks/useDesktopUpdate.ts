import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createInitialUpdateState,
  type DesktopUpdateBridge,
} from "../../shared/wemail/update";

type UpdateAction = Exclude<
  keyof DesktopUpdateBridge,
  "getState" | "check" | "onStateChange"
>;

export function useDesktopUpdate() {
  const [state, setState] = useState(() =>
    createInitialUpdateState("", false),
  );
  const api = typeof window === "undefined"
    ? undefined
    : window.wemailDesktop?.update;

  useEffect(() => {
    if (!api) {
      return;
    }
    let active = true;
    void api.getState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => {
        if (active) toast.error("暂时无法读取更新状态。");
      });
    const unsubscribe = api.onStateChange((next) => {
      if (active) {
        setState(next);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const check = useCallback(async () => {
    if (!api) {
      return state;
    }
    try {
      const next = await api.check();
      setState(next);
      return next;
    } catch {
      toast.error("暂时无法检查更新，请稍后重试。");
      return state;
    }
  }, [api, state]);

  const call = useCallback(
    async (action: UpdateAction) => {
      if (!api) {
        return;
      }
      try {
        await api[action]();
      } catch {
        toast.error("更新操作没有完成，请稍后重试。");
      }
    },
    [api],
  );

  return {
    state,
    check,
    download: () => call("download"),
    cancelDownload: () => call("cancelDownload"),
    retryDownload: () => call("retryDownload"),
    dismissAvailableUpdate: () => call("dismissAvailableUpdate"),
    installNow: () => call("installNow"),
    installOnExit: () => call("installOnExit"),
  };
}

export type DesktopUpdateHook = ReturnType<typeof useDesktopUpdate>;
