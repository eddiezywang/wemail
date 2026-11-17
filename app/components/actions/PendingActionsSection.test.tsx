import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AgentPendingAction } from "~/services/api";
import { PendingActionsSection } from "./PendingActionsSection";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("~/queries/pendingActions", () => ({
  useResolvePendingAction: () => ({ mutate, isPending: false }),
}));

it("confirms the exact displayed parameters and idempotency key from the action center", async () => {
  const action: AgentPendingAction = {
    id: "upload", actionType: "upload_allowance_invoices", description: "上传发票",
    toolName: "propose_allowance_invoice_upload", inputJson: "{}", riskReason: "上传", riskLevel: "high",
    idempotencyKey: "authorization", parameters: { items: [{ emailId: "mail", attachmentId: "attachment" }] },
  };
  render(<QueryClientProvider client={new QueryClient()}><PendingActionsSection actions={[action]} /></QueryClientProvider>);
  await userEvent.click(screen.getByTestId("pending-action-confirm"));
  expect(mutate).toHaveBeenCalledWith({ id: "upload", status: "confirmed", idempotencyKey: "authorization", parameters: action.parameters }, expect.any(Object));
});
