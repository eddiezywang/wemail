import type {
  DesktopUpdateBridge,
  DesktopUpdateState,
} from "../../shared/wemail/update.js";

export interface IpcSubscription {
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  off: (channel: string, listener: (...args: unknown[]) => void) => void;
}

interface UpdateIpc extends IpcSubscription {
  invoke: (channel: string) => Promise<unknown>;
}

export function getApiBaseUrlFromArgv(argv: string[]): string | undefined {
  const arg = argv.find((value) => value.startsWith("--wemail-api-port="));
  const port = arg?.split("=")[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
}

export function subscribeDesktopEvent<TArgs extends unknown[]>(
  ipc: IpcSubscription,
  channel: string,
  listener: (...args: TArgs) => void,
) {
  ipc.on(channel, listener as (...args: unknown[]) => void);
  return () => {
    ipc.off(channel, listener as (...args: unknown[]) => void);
  };
}

export function createDesktopUpdateBridge(ipc: UpdateIpc): DesktopUpdateBridge {
  const invokeState = (channel: string) =>
    ipc.invoke(channel) as Promise<DesktopUpdateState>;
  const invokeAction = async (channel: string) => {
    await ipc.invoke(channel);
  };

  return {
    getState: () => invokeState("update:get-state"),
    check: () => invokeState("update:check"),
    download: () => invokeAction("update:download"),
    cancelDownload: () => invokeAction("update:cancel-download"),
    retryDownload: () => invokeAction("update:retry-download"),
    dismissAvailableUpdate: () => invokeAction("update:dismiss"),
    installNow: () => invokeAction("update:install-now"),
    installOnExit: () => invokeAction("update:install-on-exit"),
    onStateChange(listener) {
      const ipcListener = (_event: unknown, state: DesktopUpdateState) => {
        listener(state);
      };
      return subscribeDesktopEvent(
        ipc,
        "update:state-changed",
        ipcListener,
      );
    },
  };
}
