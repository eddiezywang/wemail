import { describe, expect, it } from "vitest";
import {
  CoreHealthResultSchema,
  CoreRequestSchema,
  CoreResponseSchema,
  MAIL_CORE_PROTOCOL_VERSION,
} from "./mailCoreProtocol.js";

describe("Mail Core protocol", () => {
  it("accepts a versioned health request", () => {
    expect(CoreRequestSchema.parse({
      version: MAIL_CORE_PROTOCOL_VERSION,
      requestId: "req-1",
      traceId: "trace-1",
      method: "core.health",
      params: {},
    })).toMatchObject({ method: "core.health" });
  });

  it("rejects unknown methods and protocol versions", () => {
    expect(() => CoreRequestSchema.parse({
      version: 2,
      requestId: "req-1",
      traceId: "trace-1",
      method: "mail.anything",
      params: {},
    })).toThrow();
  });

  it("validates success and failure responses", () => {
    expect(CoreResponseSchema.parse({
      version: MAIL_CORE_PROTOCOL_VERSION,
      requestId: "req-1",
      ok: true,
      result: CoreHealthResultSchema.parse({
        protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
        state: "ready",
        pid: 123,
        startedAt: "2026-07-28T00:00:00.000Z",
        uptimeMs: 25,
      }),
      timing: { queueMs: 0, handlerMs: 1, totalMs: 1 },
    }).ok).toBe(true);

    expect(CoreResponseSchema.parse({
      version: MAIL_CORE_PROTOCOL_VERSION,
      requestId: "req-2",
      ok: false,
      error: { code: "INVALID_REQUEST", message: "invalid", retryable: false },
    }).ok).toBe(false);
  });

  it("preserves background and intelligence worker health metrics", () => {
    const health = CoreHealthResultSchema.parse({
      protocolVersion: MAIL_CORE_PROTOCOL_VERSION,
      state: "ready",
      pid: 123,
      startedAt: "2026-07-29T00:00:00.000Z",
      uptimeMs: 25,
      backgroundRuntime: {
        state: "ready",
        threadId: 4,
        currentJobId: null,
        currentJobKind: null,
        lastHeartbeatAt: 100,
      },
      intelligenceRuntime: {
        state: "ready",
        threadId: 5,
        lastHeartbeatAt: 101,
        memory: {
          heapUsedBytes: 10,
          heapTotalBytes: 20,
          externalBytes: 30,
          arrayBuffersBytes: 40,
        },
      },
      apiRuntime: {
        state: "ready",
        threadId: 6,
        port: 43123,
        lastHeartbeatAt: 102,
      },
    });

    expect(health.intelligenceRuntime?.memory?.heapUsedBytes).toBe(10);
    expect(health.backgroundRuntime?.threadId).toBe(4);
    expect(health.apiRuntime?.port).toBe(43123);
  });
});
