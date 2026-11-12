import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createWriteFileWithRetry } = require(
  "../../scripts/windows-executable-write-retry.cjs",
);

test("retries a transient Windows executable write", async () => {
  const calls = [];
  const writeFile = createWriteFileWithRetry(
    async () => {
      calls.push("write");
      if (calls.length === 1) {
        const error = new Error("temporarily locked");
        error.code = "UNKNOWN";
        throw error;
      }
    },
    {
      delays: [0],
      sleep: async () => calls.push("sleep"),
    },
  );

  await writeFile("C:\\build\\WeMail.exe", Buffer.alloc(0));
  assert.deepEqual(calls, ["write", "sleep", "write"]);
});

test("does not retry unrelated writes", async () => {
  let calls = 0;
  const expected = Object.assign(new Error("disk failure"), { code: "EIO" });
  const writeFile = createWriteFileWithRetry(async () => {
    calls += 1;
    throw expected;
  });

  await assert.rejects(writeFile("C:\\build\\WeMail.exe", Buffer.alloc(0)), expected);
  assert.equal(calls, 1);
});
