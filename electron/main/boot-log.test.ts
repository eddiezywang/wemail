import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createBootLogger } from "./boot-log.js";

describe("boot log", () => {
  it("ignores stderr write failures during desktop startup", () => {
    const write = vi.fn(() => {
      throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    });
    const appendFileSync = vi.fn();
    const logger = createBootLogger({
      pid: 123,
      stderr: { write },
      fs: { appendFileSync },
    });

    expect(() => logger.log("module-loaded")).not.toThrow();
    expect(write).toHaveBeenCalledOnce();
  });

  it("absorbs an asynchronous EPIPE event and disables later pipe writes", async () => {
    const stream = new EventEmitter() as EventEmitter & {
      write: (value: string, callback?: (error?: Error | null) => void) => boolean;
    };
    const write = vi.fn(() => {
      queueMicrotask(() => {
        stream.emit(
          "error",
          Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
        );
      });
      return false;
    });
    stream.write = write;
    const logger = createBootLogger({
      pid: 123,
      stderr: stream,
      fs: { appendFileSync: vi.fn() },
    });

    logger.log("module-loaded");
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => logger.log("ready")).not.toThrow();
    expect(write).toHaveBeenCalledOnce();
  });

  it("prints the level outside the structured body", () => {
    const writes: string[] = [];
    const logger = createBootLogger({
      pid: 123,
      stderr: { write: (value) => { writes.push(value); return true; } },
      fs: { appendFileSync: vi.fn() },
    });

    logger.log("summary-automation-triggered", { level: "info", accountId: "acct-1" });

    expect(writes[0]).toContain("] [info] ");
    expect(writes[0]).toContain('"accountId":"acct-1"');
    expect(writes[0]).not.toContain('"level":"info"');
  });
});
