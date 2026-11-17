import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchMailAuthRequired,
  MAIL_CREDENTIAL_INVALID,
} from "~/lib/mailCredentialEvents";
import MailCredentialDialog from "./MailCredentialDialog";
import { ApiError } from "~/services/api";

const mocks = vi.hoisted(() => ({
  loginAccount: vi.fn(),
  logoutAccount: vi.fn(),
  syncMail: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("~/queries/currentAccount", () => ({
  useCurrentAccount: () => ({
    data: {
      account: {
        id: "acct-1",
        emailAddress: "user@example.com",
        displayName: "User",
        imap: {
          host: "wemail.example.com",
          port: 993,
          secure: true,
          username: "user@example.com",
        },
        smtp: {
          host: "wemail.example.com",
          port: 465,
          secure: true,
          username: "user@example.com",
        },
      },
    },
    isLoading: false,
  }),
}));

vi.mock("~/services/api", () => ({
  default: {
    loginAccount: mocks.loginAccount,
    logoutAccount: mocks.logoutAccount,
    syncMail: mocks.syncMail,
  },
  ApiError: class ApiError extends Error {
    status: number;
    body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>) {
      super("api error");
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MailCredentialDialog />
    </QueryClientProvider>,
  );
}

describe("MailCredentialDialog", () => {
  beforeEach(() => {
    mocks.loginAccount.mockReset();
    mocks.logoutAccount.mockReset();
    mocks.syncMail.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it("updates both passwords and automatically runs a 30-day recovery sync", async () => {
    mocks.loginAccount.mockResolvedValue({ ok: true });
    mocks.syncMail.mockResolvedValue({ queued: true, synced: true });
    const user = userEvent.setup();
    renderDialog();

    act(() => {
      dispatchMailAuthRequired({
        accountId: "acct-1",
        code: MAIL_CREDENTIAL_INVALID,
        source: "background",
      });
    });

    expect(await screen.findByText("邮箱密码需要更新")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("输入更新后的邮箱密码"), "new-secret");
    await user.click(screen.getByRole("button", { name: "更新密码" }));

    await waitFor(() => {
      expect(mocks.loginAccount).toHaveBeenCalledWith({
        config: {
          id: "acct-1",
          emailAddress: "user@example.com",
          displayName: "User",
          imap: {
            host: "wemail.example.com",
            port: 993,
            secure: true,
            username: "user@example.com",
          },
          smtp: {
            host: "wemail.example.com",
            port: 465,
            secure: true,
            username: "user@example.com",
          },
        },
        secrets: {
          imapPassword: "new-secret",
          smtpPassword: "new-secret",
        },
      });
    });
    expect(mocks.syncMail).toHaveBeenCalledWith({ mode: "window", days: 30 });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("密码已更新，邮件同步已恢复");
    await waitFor(() => {
      expect(screen.queryByText("邮箱密码需要更新")).not.toBeInTheDocument();
    });
  });

  it("keeps one dialog open when duplicate background events arrive", async () => {
    renderDialog();

    act(() => {
      dispatchMailAuthRequired({
        accountId: "acct-1",
        code: MAIL_CREDENTIAL_INVALID,
        source: "background",
      });
      dispatchMailAuthRequired({
        accountId: "acct-1",
        code: MAIL_CREDENTIAL_INVALID,
        source: "background",
      });
    });

    expect(await screen.findAllByText("邮箱密码需要更新")).toHaveLength(1);
  });

  it("cannot be dismissed and only offers password update or account logout", async () => {
    const user = userEvent.setup();
    renderDialog();

    act(() => {
      dispatchMailAuthRequired({
        accountId: "acct-1",
        code: MAIL_CREDENTIAL_INVALID,
        source: "background",
      });
    });

    expect(await screen.findByText("邮箱密码需要更新")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "稍后处理" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByText("邮箱密码需要更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出当前邮箱账号" })).toBeInTheDocument();
  });

  it("allows leaving the blocked state by logging out of the current account", async () => {
    mocks.logoutAccount.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderDialog();

    act(() => {
      dispatchMailAuthRequired({
        accountId: "acct-1",
        code: MAIL_CREDENTIAL_INVALID,
        source: "background",
      });
    });

    await user.click(await screen.findByRole("button", { name: "退出当前邮箱账号" }));
    await waitFor(() => expect(mocks.logoutAccount).toHaveBeenCalledOnce());
    expect(screen.queryByText("邮箱密码需要更新")).not.toBeInTheDocument();
  });

  it("keeps the dialog open when the new password cannot restore login", async () => {
    mocks.loginAccount.mockResolvedValue({ ok: true });
    mocks.syncMail.mockRejectedValue(
      new ApiError(401, { code: "MAIL_CREDENTIAL_INVALID" }),
    );
    const user = userEvent.setup();
    renderDialog();

    act(() => {
      dispatchMailAuthRequired({
        accountId: "acct-1",
        code: MAIL_CREDENTIAL_INVALID,
        source: "manual",
      });
    });

    await user.type(
      await screen.findByPlaceholderText("输入更新后的邮箱密码"),
      "still-wrong",
    );
    await user.click(screen.getByRole("button", { name: "更新密码" }));

    expect(
      await screen.findByText("密码验证未能恢复连接，请确认新密码是否正确。"),
    ).toBeInTheDocument();
    expect(screen.getByText("邮箱密码需要更新")).toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
