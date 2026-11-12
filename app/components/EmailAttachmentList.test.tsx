// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EmailAttachmentList from "~/components/EmailAttachmentList";

// P2.6: the invoice platform surface (badges, refresh, messages) renders
// only behind the edition feature flag.
const editionFeatures = vi.hoisted(() => ({ allowanceInvoice: true }));
vi.mock("~/hooks/useEditionFeatures", () => ({
	useEditionFeatures: () => ({
		wecli: false,
		allowanceInvoice: editionFeatures.allowanceInvoice,
		enterpriseDirectory: false,
		officeSceneDetection: false,
	}),
}));
import type { Attachment } from "~/types";

const downloadFileMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
	vi.resetModules();
});

vi.mock("sonner", () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}));

vi.mock("~/lib/utils", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("~/lib/utils");
  return {
    ...actual,
    downloadFile: downloadFileMock,
  };
});

const pdfAttachment: Attachment = {
  id: "att-1",
  filename: "report.pdf",
  mimetype: "application/pdf",
  size: 1024 * 512,
  contentId: "",
};

const imageAttachment: Attachment = {
  id: "att-2",
  filename: "photo.png",
  mimetype: "image/png",
  size: 1024 * 256,
  contentId: "inline-1",
};

const inlineImageAttachment: Attachment = {
  id: "att-3",
  filename: "logo.png",
  mimetype: "image/png",
  size: 1024,
  contentId: "logo-inline",
  // `getNonInlineAttachments` filters on `disposition` (the IMAP-standard
  // signal) rather than `contentId` alone. Real inline images carry both.
  disposition: "inline",
};

describe("EmailAttachmentList", () => {
  it("keeps the generic upload-failure label for platform rejection errors", () => {
    // P2.6 round 8: the platform rejection parsing (the bounded
    // "平台核验未通过" reason and the expense-binding judgment) is edition
    // semantics (`internal/src/allowance/invoiceShared.ts`). The open
    // edition renders the generic status label and the generic retry hint
    // even for rows carrying a platform rejection string.
    render(<EmailAttachmentList mailboxId="mb-1" emailId="msg-1" attachments={[pdfAttachment]}
      invoiceStatus={{ tag: "未处理发票", state: "upload_failed", statuses: [{
        accountId: "mb-1", emailId: "msg-1", attachmentId: "att-1", status: "upload_failed",
        lastError: "平台核验未通过：当前发票已经在费控中绑定！", createdAt: "", updatedAt: "",
      }] }} />);
    expect(screen.getByText("上传失败")).toBeInTheDocument();
    expect(screen.getByText("上传没有完成，请查看执行卡片中的原因")).toBeInTheDocument();
    expect(screen.queryByText("费控已绑定，本次未接收")).toBeNull();
    expect(screen.queryByText(/平台验票/)).toBeNull();
    expect(screen.queryByText("已被他人关联")).toBeNull();
  });
  it("keeps refresh feedback beside the attachment statuses", () => {
    render(<EmailAttachmentList mailboxId="mb-1" emailId="msg-1" attachments={[pdfAttachment]}
      invoiceRefreshMessage="12:30:00 · 平台查询已完成" invoiceStatus={{ tag: "已处理发票", state: "associated_self", statuses: [{
        accountId: "mb-1", emailId: "msg-1", attachmentId: "att-1", status: "associated_self", createdAt: "", updatedAt: "",
      }] }} />);
    expect(screen.getByRole("status")).toHaveTextContent("平台查询已完成");
    expect(screen.getByText("本人已关联")).toBeInTheDocument();
  });

  it("shows login recovery even for invoice mail without attachments", () => {
    render(<EmailAttachmentList mailboxId="mb-1" emailId="msg-1" attachments={[]}
      invoiceRefreshMessage="发票平台未登录，本次未能刷新" onRefreshInvoiceStatus={vi.fn()} showHeading />);
    expect(screen.getByRole("status")).toHaveTextContent("本次未能刷新");
    // P2.6: the platform login link is edition data and no longer exists in
    // any edition's renderer — the message stays text-only.
    expect(screen.queryByRole("link", { name: "打开平台登录" })).toBeNull();
  });
  beforeEach(() => {
    downloadFileMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  it("renders nothing when mailboxId is not provided", () => {
    const { container } = render(
      <EmailAttachmentList emailId="msg-1" attachments={[pdfAttachment]} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when attachments array is empty", () => {
    const { container } = render(
      <EmailAttachmentList mailboxId="mb-1" emailId="msg-1" attachments={[]} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders non-inline attachments", () => {
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
      />
    );
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("renders invoice upload status for matching attachments", () => {
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
        invoiceStatus={{
          tag: "已处理发票",
          state: "associated_other",
          statuses: [
            {
              accountId: "acct-1",
              emailId: "msg-1",
              attachmentId: "att-1",
              filename: "report.pdf",
              status: "associated_other",
              lastError: "已被其他人关联",
              createdAt: "2026-04-27T12:00:00.000Z",
              updatedAt: "2026-04-27T12:01:00.000Z",
            },
          ],
        }}
      />
    );

    expect(screen.getByText("已被他人关联")).toBeInTheDocument();
    expect(
      screen.getByText("上传没有完成，请查看执行卡片中的原因"),
    ).toBeInTheDocument();
  });

  it("lets the user refresh invoice platform status", async () => {
    const user = userEvent.setup();
    const onRefreshInvoiceStatus = vi.fn();
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
        invoiceStatus={{ tag: "未处理发票", state: "not_uploaded", statuses: [] }}
        onRefreshInvoiceStatus={onRefreshInvoiceStatus}
        showHeading
      />,
    );

    await user.click(screen.getByRole("button", { name: "刷新发票平台状态" }));

    expect(onRefreshInvoiceStatus).toHaveBeenCalledTimes(1);
  });

  it("filters out inline attachments", () => {
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[inlineImageAttachment]}
      />
    );
    expect(screen.queryByText("logo.png")).toBeNull();
  });

  it("shows heading with count when showHeading is true", () => {
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
        showHeading
      />
    );
    expect(screen.getByText("1 个附件")).toBeInTheDocument();
  });

  it("shows plural attachments in heading", () => {
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment, imageAttachment]}
        showHeading
      />
    );
    expect(screen.getByText("2 个附件")).toBeInTheDocument();
  });

  it("previews image attachments from the dedicated preview button", async () => {
    const user = userEvent.setup();
    const onPreviewImage = vi.fn();
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[imageAttachment]}
        onPreviewImage={onPreviewImage}
      />
    );
    const button = screen.getByRole("button", { name: /预览附件 photo.png/ });
    expect(button).toBeInTheDocument();
    await user.click(button);
    expect(onPreviewImage).toHaveBeenCalledTimes(1);
  });

  it("opens a confirmation prompt before downloading an attachment", async () => {
    const user = userEvent.setup();
    downloadFileMock.mockResolvedValue(undefined);
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
      />
    );

    await user.click(screen.getByRole("button", { name: /下载附件 report.pdf/ }));

    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("下载附件？");
    expect(screen.getByRole("dialog")).toHaveTextContent("report.pdf");

	await user.click(screen.getByRole("button", { name: "下载" }));

	await waitFor(() =>
		expect(downloadFileMock).toHaveBeenCalledWith(
			"http://localhost:3000/api/mail/messages/msg-1/attachments/att-1",
			"report.pdf",
		),
	);
  });

  it("closes the confirmation prompt immediately after download is confirmed", async () => {
    const user = userEvent.setup();
    downloadFileMock.mockImplementation(() => new Promise(() => {}));
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
      />
    );

    await user.click(screen.getByRole("button", { name: /下载附件 report.pdf/ }));
	await user.click(screen.getByRole("button", { name: "下载" }));

	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(downloadFileMock).toHaveBeenCalledWith(
		"http://localhost:3000/api/mail/messages/msg-1/attachments/att-1",
		"report.pdf",
	);
  });

  it("shows a lightweight success toast after attachment download starts", async () => {
    const user = userEvent.setup();
    downloadFileMock.mockResolvedValue(undefined);
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[pdfAttachment]}
      />
    );

    await user.click(screen.getByRole("button", { name: /下载附件 report.pdf/ }));
    await user.click(screen.getByRole("button", { name: "下载" }));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("附件下载已开始");
    });
  });

  it("renders image as downloadable when preview is not provided", async () => {
    const user = userEvent.setup();
    render(
      <EmailAttachmentList
        mailboxId="mb-1"
        emailId="msg-1"
        attachments={[imageAttachment]}
      />
    );
    await user.click(screen.getByRole("button", { name: /下载附件 photo.png/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("photo.png");
  });
});
