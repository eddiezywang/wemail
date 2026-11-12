import { describe, expect, it } from "vitest";
import { formatProcessLog } from "./process-log.js";

describe("process log formatting", () => {
  it("keeps level in the service prefix instead of the JSON body", () => {
    const output = formatProcessLog(
      "[mail-core]",
      JSON.stringify({ phase: "account-worker-memory", level: "debug", tick: 1 }),
      "debug",
      { color: false },
    );

    expect(output).toBe('[mail-core] [debug] {"phase":"account-worker-memory","tick":1}');
  });

  it("uses the requested level color", () => {
    const output = formatProcessLog("[db-service]", "wal_checkpoint", "warn");

    expect(output).toContain("\u001b[33m[db-service] [warn]");
    expect(output).toContain("wal_checkpoint");
  });
});
