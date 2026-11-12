import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  resolveClaudeCodeBinary,
  resolveClaudeCodeLaunch,
  ClaudeCodeTaskService,
} from "./ClaudeCodeRuntime.js";
import { windowsCommandProcessor } from "../skills/wecliPort.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("resolveClaudeCodeBinary finds Windows npm shims without shell lookup", () => {
  const result = resolveClaudeCodeBinary("claude", {
    platform: "win32",
    pathEnv: "C:\\tools;C:\\npm",
    exists: (candidate) => candidate === "C:\\npm\\claude.cmd",
  });
  assert.equal(result, "C:\\npm\\claude.cmd");
});

test("resolveClaudeCodeLaunch wraps Windows cmd shims with explicit cmd.exe args", () => {
  const launch = resolveClaudeCodeLaunch(
    "C:\\npm\\claude.cmd",
    ["-p", "fix & review", "--output-format", "stream-json"],
    { platform: "win32" },
  );
  assert.equal(launch.command, windowsCommandProcessor());
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.equal(launch.args[0], "/d");
  assert.match(launch.args.at(-1) ?? "", /fix & review/);
});

test("Claude Code task start returns immediately and uses Hermes print-mode flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wemail-claude-code-"));
  const calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  class FakeChild extends EventEmitter {
    pid = 41234;
    exitCode: number | null = null;
    unref(): this {
      return this;
    }
  }
  try {
    const service = new ClaudeCodeTaskService({
      dataDir: root,
      logger,
      platform: "linux",
      binary: "claude",
      spawnImpl: ((command: string, args: string[], options: SpawnOptions) => {
        calls.push({ command, args, options });
        return new FakeChild() as unknown as ChildProcess;
      }) as typeof import("node:child_process").spawn,
      hardTimeoutMs: 60_000,
    });
    const task = service.start({
      cwd: root,
      prompt: "Fix the repository and report changed files.",
      maxTurns: 7,
    });

    assert.equal(task.status, "running");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "claude");
    assert.deepEqual(calls[0].args.slice(0, 2), ["-p", "Fix the repository and report changed files."]);
    assert.ok(calls[0].args.includes("--output-format"));
    assert.ok(calls[0].args.includes("stream-json"));
    assert.ok(calls[0].args.includes("--dangerously-skip-permissions"));
    assert.ok(calls[0].args.includes("--max-turns"));
    assert.equal(calls[0].options.cwd, root);
    assert.equal(calls[0].options.detached, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
