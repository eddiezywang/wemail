import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  resolveDesktopProfileLaunch,
  resolveInspectPort,
} from "../../scripts/desktop-profile-options.mjs";

test("profile launch adds the default inspector without forwarding wrapper flags", () => {
  const result = resolveDesktopProfileLaunch(
    ["--wemail-profile", "--no-sandbox", "dist-electron/electron/main/app.js"],
    {},
    "C:\\repo",
  );
  assert.deepEqual(result.electronArgs, [
    "--inspect=9229",
    "--no-sandbox",
    "dist-electron/electron/main/app.js",
  ]);
  assert.equal(result.childEnv.WEMAIL_DEV_TRACE, undefined);
});
test("trace launch enables tracing and resolves its output directory", () => {
  const result = resolveDesktopProfileLaunch(
    ["--wemail-trace", "app.js"],
    { WEMAIL_INSPECT_PORT: "9333", WEMAIL_TRACE_OUTPUT_DIR: "reports/perf" },
    "C:\\repo",
  );
  assert.deepEqual(result.electronArgs, ["--inspect=9333", "app.js"]);
  assert.equal(result.childEnv.WEMAIL_DEV_TRACE, "1");
  assert.equal(
    result.childEnv.WEMAIL_TRACE_OUTPUT_DIR,
    path.resolve("C:\\repo", "reports/perf"),
  );
});

test("invalid inspector ports fail before Electron is spawned", () => {
  assert.throws(() => resolveInspectPort("0"), /integer in \[1, 65535\]/);
  assert.throws(() => resolveInspectPort("abc"), /integer in \[1, 65535\]/);
});
