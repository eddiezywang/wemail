import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  MAIL_DATABASE_PROTOCOL_VERSION,
  type MailDatabaseRequest,
} from "../../shared/wemail/mailDatabaseProtocol.js";
import { DbServiceWorkerLane } from "./worker-lane.js";

describe("DbServiceWorkerLane cancellation", () => {
  let lane: DbServiceWorkerLane | null = null;

  afterEach(async () => {
    await lane?.stop();
    lane = null;
  });

  test("background reader cancellation does not restart an in-flight detail reader", async () => {
    const options = {
      entryPath: fileURLToPath(new URL("./fixtures/worker-lane-fixture.mjs", import.meta.url)),
      databasePath: "unused-by-fixture.sqlite",
      mode: "reader" as const,
      requestTimeoutMs: 2_000,
    };
    lane = new DbServiceWorkerLane({ ...options, label: "detail" });
    const background = new DbServiceWorkerLane({ ...options, label: "background" });
    try {
      await Promise.all([lane.start(), background.start()]);
      const detailThread = lane.health().threadId;
      const makeRequest = (requestId: string): MailDatabaseRequest => ({
        version: MAIL_DATABASE_PROTOCOL_VERSION,
        requestId, traceId: requestId, method: "mail.getSnapshot",
        params: { id: requestId }, deadlineMs: Date.now() + 2_000,
      });
      const stale = background.call(makeRequest("background-stale")).catch((error) => error);
      const detail = lane.call(makeRequest("foreground-current"));
      expect(background.cancel("background-stale")).toBe(true);
      await expect(stale).resolves.toMatchObject({ name: "AbortError" });
      await expect(detail).resolves.toMatchObject({ result: { requestId: "foreground-current" } });
      expect(lane.health().threadId).toBe(detailThread);
      expect(lane.health().restartCount).toBe(0);
    } finally {
      await background.stop();
    }
  });

  test("recycles a cancelled reader and preserves a newer queued detail request", async () => {
    lane = new DbServiceWorkerLane({
      entryPath: fileURLToPath(
        new URL("./fixtures/worker-lane-fixture.mjs", import.meta.url),
      ),
      databasePath: "unused-by-fixture.sqlite",
      label: "detail",
      mode: "reader",
      requestTimeoutMs: 2_000,
    });
    await lane.start();
    const makeRequest = (requestId: string): MailDatabaseRequest => ({
      version: MAIL_DATABASE_PROTOCOL_VERSION,
      requestId,
      traceId: requestId,
      method: "mail.getSnapshot",
      params: { id: requestId },
      deadlineMs: Date.now() + 2_000,
    });

    const stale = lane.call(makeRequest("detail-stale")).catch((error) => error);
    const current = lane.call(makeRequest("detail-current"));
    expect(lane.cancel("detail-stale")).toBe(true);

    const staleError = await stale;
    expect(staleError).toMatchObject({ name: "AbortError" });
    await expect(current).resolves.toMatchObject({
      result: { requestId: "detail-current" },
    });
    expect(lane.health().restartCount).toBe(0);
  });
});
