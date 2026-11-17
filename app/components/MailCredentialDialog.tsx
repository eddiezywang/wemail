import { KeyIcon } from "@phosphor-icons/react/Key";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  MAIL_AUTH_REQUIRED_EVENT,
  isMailCredentialInvalidBody,
  type MailAuthRequiredDetail,
} from "~/lib/mailCredentialEvents";
import { useCurrentAccount } from "~/queries/currentAccount";
import { queryKeys } from "~/queries/keys";
import api, { ApiError } from "~/services/api";
import { getUserFacingError } from "~/lib/user-facing-error";

export default function MailCredentialDialog() {
  const queryClient = useQueryClient();
  const currentAccount = useCurrentAccount();
  const account = currentAccount.data?.account;
  const [requestedAccountId, setRequestedAccountId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const isBusy = isSubmitting || isLoggingOut;

  const open = Boolean(
    requestedAccountId && account && account.id === requestedAccountId,
  );

  useEffect(() => {
    const onAuthRequired = (event: Event) => {
      const detail = (event as CustomEvent<MailAuthRequiredDetail>).detail;
      if (!detail?.accountId) return;
      setRequestedAccountId(detail.accountId);
      setError(null);
    };
    window.addEventListener(MAIL_AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(MAIL_AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  useEffect(() => {
    if (!requestedAccountId || currentAccount.isLoading) return;
    if (!account || account.id !== requestedAccountId) {
      setRequestedAccountId(null);
      setPassword("");
      setError(null);
    }
  }, [account, currentAccount.isLoading, requestedAccountId]);

  const logout = async () => {
    if (isBusy) return;
    setIsLoggingOut(true);
    setError(null);
    try {
      await api.logoutAccount();
      if (account?.id) {
        await window.wemailDesktop?.agentDrafts?.clearAccount(account.id).catch(() => undefined);
      }
      setRequestedAccountId(null);
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["account", "current"] });
    } catch (caught) {
	  setError(getUserFacingError(caught, "退出邮箱账号失败，请稍后重试。"));
    } finally {
      setIsLoggingOut(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account || isBusy) return;
    if (!password) {
      setError("请输入新的邮箱密码");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    let credentialsSaved = false;
    try {
      await api.loginAccount({
        config: {
          id: account.id,
          emailAddress: account.emailAddress,
          displayName: account.displayName,
          imap: account.imap,
          smtp: account.smtp,
        },
        secrets: {
          imapPassword: password,
          smtpPassword: password,
        },
      });
      credentialsSaved = true;
      await api.syncMail({ mode: "window", days: 30 });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["account", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["emails", account.id] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(account.id) }),
      ]);
      setRequestedAccountId(null);
      setPassword("");
      toast.success("密码已更新，邮件同步已恢复");
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        isMailCredentialInvalidBody(caught.body)
      ) {
        setError("密码验证未能恢复连接，请确认新密码是否正确。");
      } else if (!credentialsSaved) {
        setError("密码验证失败，请检查新密码是否正确。");
      } else {
        setRequestedAccountId(null);
        setPassword("");
		toast.error(getUserFacingError(caught, "密码已更新，但邮件同步暂时失败。"));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
    >
      <DialogContent
        className="max-w-[430px] overflow-hidden p-0"
        showClose={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form onSubmit={submit}>
          <div className="border-b border-edge bg-[linear-gradient(135deg,var(--color-paper-2),var(--color-paper-3))] px-6 py-5">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-coral/25 bg-coral/10 text-coral">
              <KeyIcon size={20} weight="duotone" />
            </div>
            <DialogHeader>
              <DialogTitle>邮箱密码需要更新</DialogTitle>
              <DialogDescription className="leading-6">
                当前邮箱密码已失效或已变更。更新后，WeMail 将验证凭据并自动恢复同步。
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-4 px-6 py-5">
            <div className="flex items-center gap-3 rounded-lg border border-edge bg-paper px-3.5 py-3">
              <ShieldCheckIcon className="shrink-0 text-ink-3" size={18} />
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-[0.12em] text-ink-3">
                  当前邮箱
                </div>
                <div className="truncate text-sm font-medium text-ink">
                  {account?.emailAddress ?? ""}
                </div>
              </div>
            </div>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-ink">新密码</span>
              <Input
                autoFocus
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError(null);
                }}
                autoComplete="new-password"
                placeholder="输入更新后的邮箱密码"
                disabled={isBusy}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "mail-password-error" : undefined}
              />
            </label>

            {error ? (
              <div
                id="mail-password-error"
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red/25 bg-red/5 px-3 py-2.5 text-sm text-red"
              >
                <WarningCircleIcon className="mt-0.5 shrink-0" size={16} />
                <span>{error}</span>
              </div>
            ) : null}

            <p className="text-xs leading-5 text-ink-3">
              密码仅用于连接邮箱，并会安全保存到本机凭据存储中。
            </p>
          </div>

          <DialogFooter className="border-t border-edge bg-paper px-6 py-4">
            <Button type="button" variant="ghost" onClick={() => void logout()} disabled={isBusy}>
              {isLoggingOut ? "正在退出…" : "退出当前邮箱账号"}
            </Button>
            <Button type="submit" disabled={isBusy || !password}>
              {isSubmitting ? "正在验证…" : "更新密码"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
