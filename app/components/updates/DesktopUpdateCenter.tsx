import {
  ArrowCircleDownIcon,
  CheckCircleIcon,
  ShieldWarningIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { DesktopUpdateState } from "../../../shared/wemail/update";
import { useDesktopUpdate } from "~/hooks/useDesktopUpdate";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

export const SECURITY_FAILURE_MESSAGE =
  "无法验证更新包的发布者或完整性。为保护你的设备，WeMail 不会安装此更新。";

function formatSize(size: number | null) {
  if (size === null || !Number.isFinite(size) || size < 0) {
    return null;
  }
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function indicatorLabel(state: DesktopUpdateState) {
  switch (state.status) {
    case "available":
      return state.promptSuppressed
        ? null
        : `发现新版本${state.availableVersion ? ` ${state.availableVersion}` : ""}`;
    case "downloaded":
      return "更新已下载，等待安装";
    case "install-on-exit":
      return "更新将在退出时安装";
    case "download-failed":
      return "更新下载失败";
    case "security-failed":
      return "更新安全验证失败";
    case "install-failed":
      return "更新安装未能启动";
    default:
      return null;
  }
}

function IndicatorIcon({ status }: { status: DesktopUpdateState["status"] }) {
  if (status === "downloaded" || status === "install-on-exit") {
    return <CheckCircleIcon size={18} weight="fill" />;
  }
  if (status === "security-failed") {
    return <ShieldWarningIcon size={18} weight="fill" />;
  }
  if (status === "download-failed" || status === "install-failed") {
    return <WarningCircleIcon size={18} weight="fill" />;
  }
  return <ArrowCircleDownIcon size={18} weight="fill" />;
}

export function DesktopUpdateCenter() {
  const update = useDesktopUpdate();
  const { state } = update;
  const [open, setOpen] = useState(
    () =>
      state.status === "downloading" ||
      state.status === "installing" ||
      shouldOpenAvailablePrompt(state),
  );
  const promptedAvailableVersionRef = useRef<string | null>(
    shouldOpenAvailablePrompt(state) ? availablePromptKey(state) : null,
  );
  const label = indicatorLabel(state);
  const size = formatSize(state.size);

  useEffect(() => {
    if (state.status === "installing") {
      setOpen(true);
      return;
    }
    if (!shouldOpenAvailablePrompt(state)) return;
    const promptKey = availablePromptKey(state);
    if (promptedAvailableVersionRef.current === promptKey) return;
    promptedAvailableVersionRef.current = promptKey;
    setOpen(true);
  }, [state]);

  if (!state.enabled && state.status === "disabled") {
    return null;
  }

  return (
    <>
      {!open && (label || state.status === "downloading") && state.status !== "available" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 inline-flex max-w-[360px] items-center gap-2 rounded-lg border border-edge bg-paper-2 px-4 py-3 text-sm font-medium text-ink shadow-[var(--shadow-3)] transition-colors hover:bg-paper-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-live="polite"
        >
          <IndicatorIcon status={state.status} />
          <span>{label ?? "正在下载更新"}</span>
        </button>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (
            !nextOpen &&
            (state.status === "downloading" || state.status === "installing")
          ) return;
          setOpen(nextOpen);
        }}
      >
        <DialogContent
          aria-busy={state.status === "installing" || undefined}
          className="max-w-[480px] [&>button:last-child]:hidden"
        >
          <DialogHeader>
            <DialogTitle>{dialogTitle(state)}</DialogTitle>
            <DialogDescription>{dialogDescription(state)}</DialogDescription>
          </DialogHeader>

          {state.status === "available" ? (
            <div className="space-y-3">
              {state.releaseName ? (
                <p className="text-sm font-medium text-ink">{state.releaseName}</p>
              ) : null}
              {state.releaseNotes ? (
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-ink-3">
                  {state.releaseNotes}
                </p>
              ) : null}
              {size ? <p className="text-xs text-ink-4">下载大小：{size}</p> : null}
            </div>
          ) : null}

          {state.status === "downloading" ? (
            <DownloadProgress state={state} />
          ) : null}

          {state.status === "installing" ? <InstallingProgress /> : null}

          {state.status === "security-failed" ? (
            <div className="rounded-md border border-red/30 bg-red/5 p-3 text-sm text-ink-2">
              {SECURITY_FAILURE_MESSAGE}
            </div>
          ) : null}

          <DialogFooter>{renderActions(update, () => setOpen(false))}</DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function shouldOpenAvailablePrompt(state: DesktopUpdateState) {
  return state.status === "available" && !state.promptSuppressed;
}

function availablePromptKey(state: DesktopUpdateState) {
  return state.availableVersion ?? "unknown";
}

function dialogTitle(state: DesktopUpdateState) {
  switch (state.status) {
    case "available":
      return "发现 WeMail 新版本";
    case "downloading":
      return "正在下载更新";
    case "download-failed":
      return "更新下载失败";
    case "downloaded":
      return "更新已准备好";
    case "install-on-exit":
      return "将在退出时安装";
    case "installing":
      return "正在启动安装程序";
    case "security-failed":
      return "更新安全验证失败";
    case "install-failed":
      return "更新安装未能启动";
    default:
      return "软件更新";
  }
}

function dialogDescription(state: DesktopUpdateState) {
  switch (state.status) {
    case "available":
      return `当前版本 ${state.currentVersion || "未知"}，可更新到 ${state.availableVersion || "新版本"}。下载前需要你的确认。`;
    case "downloading":
      return `正在下载 ${state.availableVersion || "新版本"}，完成后仍需选择安装时机。`;
    case "download-failed":
      return "下载没有完成。你可以重试，或稍后从“设置 > 关于”继续。";
    case "downloaded":
      return "更新已完成下载并通过验证。请选择何时重启安装。";
    case "install-on-exit":
      return "正常退出 WeMail 时会安装更新；关闭窗口到托盘不会触发安装。";
    case "installing":
      return "WeMail 正在关闭后台服务，随后会自动启动安装程序。";
    case "security-failed":
      return "此更新已被阻止。";
    case "install-failed":
      return "安装程序未能启动。请退出应用后重新打开并再次检查更新。";
    default:
      return "查看桌面应用更新状态。";
  }
}

function DownloadProgress({ state }: { state: DesktopUpdateState }) {
  const percent = Math.round(state.progress?.percent ?? 0);
  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex items-center justify-between text-xs text-ink-3">
        <span>下载进度</span>
        <span>{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="更新下载进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-paper-3"
      >
        <div
          className="h-full rounded-full bg-coral transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function InstallingProgress() {
  return (
    <div
      role="status"
      aria-live="assertive"
      aria-busy="true"
      className="flex items-center gap-4 rounded-lg border border-coral/20 bg-coral/5 p-4"
    >
      <span
        aria-hidden="true"
        className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center"
      >
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-coral/20 border-t-coral motion-reduce:animate-none" />
        <span className="h-2 w-2 rounded-full bg-coral shadow-[0_0_0_4px_var(--color-coral-bg)]" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">正在结束后台任务</span>
        <span className="mt-1 block text-xs leading-5 text-ink-3">
          请稍候，安装程序即将自动打开。
        </span>
      </span>
    </div>
  );
}

function renderActions(
  update: ReturnType<typeof useDesktopUpdate>,
  close: () => void,
) {
  switch (update.state.status) {
    case "available":
      return (
        <>
          <Button
            variant="secondary"
            onClick={() => {
              void update.dismissAvailableUpdate();
              close();
            }}
          >
            暂不更新
          </Button>
          <Button onClick={() => void update.download()}>立即更新</Button>
        </>
      );
    case "downloading":
      return (
        <Button variant="secondary" onClick={() => void update.cancelDownload()}>
          取消下载
        </Button>
      );
    case "download-failed":
      return (
        <>
          <Button variant="secondary" onClick={close}>稍后</Button>
          <Button onClick={() => void update.retryDownload()}>重试</Button>
        </>
      );
    case "downloaded":
      return (
        <>
          <Button variant="secondary" onClick={() => void update.installOnExit()}>
            退出时安装
          </Button>
          <Button onClick={() => void update.installNow()}>立即重启安装</Button>
        </>
      );
    case "install-on-exit":
      return <Button onClick={() => void update.installNow()}>立即重启安装</Button>;
    case "security-failed":
    case "install-failed":
      return <Button variant="secondary" onClick={close}>关闭</Button>;
    default:
      return null;
  }
}
