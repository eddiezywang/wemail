import type { IpcMain } from "electron";
import type { UpdateController } from "./updater.js";

function requireNoArguments(args: unknown[]) {
  if (args.length > 0) {
    throw new Error("Update IPC does not accept arguments");
  }
}

export function registerUpdateIpc(
  ipcMain: Pick<IpcMain, "handle">,
  controller: Pick<
    UpdateController,
    | "getState"
    | "check"
    | "download"
    | "cancelDownload"
    | "retryDownload"
    | "dismissAvailableUpdate"
    | "requestInstallNow"
    | "selectInstallOnExit"
  >,
) {
  const fixed = (channel: string, action: () => unknown) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      requireNoArguments(args);
      return await action();
    });
  };

  fixed("update:get-state", () => controller.getState());
  fixed("update:check", () => controller.check("manual"));
  fixed("update:download", () => controller.download());
  fixed("update:cancel-download", () => controller.cancelDownload());
  fixed("update:retry-download", () => controller.retryDownload());
  fixed("update:dismiss", () => controller.dismissAvailableUpdate());
  fixed("update:install-now", () => controller.requestInstallNow());
  fixed("update:install-on-exit", () => controller.selectInstallOnExit());
}
