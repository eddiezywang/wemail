import { useQuery } from "@tanstack/react-query";
import { toast } from "~/components/ui/sonner";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

type ShortcutStatus = {
  entries: Array<{
    location: "desktop" | "startMenu";
    path: string;
    exists: boolean;
    target: string;
    correct: boolean;
  }>;
  prompt: boolean;
  dismissed: boolean;
  currentExe: string;
};

/** Windows-only: offers to create/replace Desktop + Start Menu shortcuts so
 *  they point at the currently running WeMail (matters for portable runs and
 *  after the app moved to a new directory). */
export default function ShortcutSetupDialog() {
  const statusQuery = useQuery({
    queryKey: ["shortcut-status"],
    queryFn: () => window.wemailDesktop?.shortcuts?.getStatus(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const status: ShortcutStatus | undefined = statusQuery.data?.status;
  const open = Boolean(status?.prompt);
  const missing = status?.entries.filter((entry) => !entry.exists) ?? [];
  const stale = status?.entries.filter((entry) => entry.exists && !entry.correct) ?? [];
  if (!open || !status) return null;
  const title = missing.length === status.entries.length
    ? "创建 WeMail 快捷方式"
    : "更新 WeMail 快捷方式";
  const detail = [
    ...(missing.length
      ? [`还没有${missing.map((entry) => (entry.location === "desktop" ? "桌面" : "开始菜单")).join("和")}快捷方式。`]
      : []),
    ...(stale.length
      ? [`现有${stale.map((entry) => (entry.location === "desktop" ? "桌面" : "开始菜单")).join("和")}快捷方式指向的位置不是当前运行的 WeMail。`]
      : []),
  ].join("");

  const fix = async () => {
    try {
      await window.wemailDesktop?.shortcuts?.fix();
    } catch {
      toast.error("快捷方式更新失败，请稍后重试。");
      return;
    }
    await statusQuery.refetch();
  };
  const dismiss = async () => {
    await window.wemailDesktop?.shortcuts?.dismiss();
    await statusQuery.refetch();
  };

  return (
    <Dialog open={open} onOpenChange={() => void dismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{detail}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void dismiss()}>
            稍后再说
          </Button>
          <Button loading={statusQuery.isFetching} onClick={() => void fix()}>
            {missing.length ? "立即创建" : "立即替换"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
