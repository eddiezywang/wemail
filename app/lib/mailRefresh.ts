import type { CoreHealthResult, MailRefreshResult } from "../../shared/wemail/mailCoreProtocol";

export async function waitForMailRefresh(
  accountId: string,
  accepted: MailRefreshResult,
  readHealth: () => Promise<CoreHealthResult>,
): Promise<boolean> {
  if (accepted.receiptVersion === undefined || !accepted.runtimeId) return false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const account = (await readHealth()).accountRuntime;
    if (account?.accountId !== accountId || account.receipt?.runtimeId !== accepted.runtimeId) {
      throw new Error("邮箱同步服务正在恢复，请稍后刷新。");
    }
    if (account.state === "credential-required") {
      const error = new Error("邮箱登录已失效，请重新登录。");
      error.name = "MAIL_CREDENTIAL_INVALID";
      throw error;
    }
    if (account.receipt.completedVersion >= accepted.receiptVersion) return true;
    if (account.receipt.failedVersion >= accepted.receiptVersion) {
      throw new Error("本次刷新未完成，客户端将自动重试。");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
