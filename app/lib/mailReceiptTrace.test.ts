import { afterEach, expect, test, vi } from "vitest";
import { recordMailReceiptEvent, recordMailReceiptPaint } from "./mailReceiptTrace";

afterEach(() => vi.restoreAllMocks());

test("receipt paint requires fresh list data and the committed message in the viewport", () => {
  const log = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.spyOn(Date, "now").mockReturnValue(100);
  recordMailReceiptEvent("receipt-test", 901, ["mail-private-id"]);
  recordMailReceiptPaint("receipt-test", ["mail-private-id"], 99);
  recordMailReceiptPaint("receipt-test", ["other"], 101);
  expect(log).toHaveBeenCalledTimes(1);
  recordMailReceiptPaint("receipt-test", ["mail-private-id"], 101);
  expect(log).toHaveBeenLastCalledWith("[mail-receipt]", expect.objectContaining({
    stage: "list-painted", commitVersion: 901,
  }));
  recordMailReceiptPaint("receipt-test", ["mail-private-id"], 101);
  expect(log).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(log.mock.calls)).not.toContain("mail-private-id");
});
