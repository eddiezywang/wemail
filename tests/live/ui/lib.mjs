// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Shared driver for live UI interaction tests via `agent-desktop`
// (Windows accessibility tree). Every command prints one JSON envelope.
// These tests run against the REAL logged-in instance — they are manual
// live regression, never wired into CI.
//
// 策略：不做重量级 find --text（web UI 持续变化导致 locator 无法稳定），
// 改为「快照一次 + 本地遍历树 JSON 匹配 + 引用点击 + 失败重快照重试」。
import { spawnSync } from "node:child_process";

export const APP = "WeMailDesktop.exe";

// agent-desktop 的 npm shim 是 shell 脚本，spawnSync 无法直接执行；
// 直接用 node 跑包入口。
const CLI = [
  process.execPath,
  "E:/npm-global/node_modules/agent-desktop/bin/agent-desktop",
];

/** Run one agent-desktop command and return the parsed JSON envelope. */
export function run(args, { timeoutMs = 90_000 } = {}) {
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args.map(String)], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(
      `agent-desktop ${args[0]} failed: ${res.stderr?.slice(0, 120) || res.status}`,
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Full snapshot, local DFS match by role/name-substring.
 * Returns the first matching node (with ref_id) or null.
 */
export function snapshotMatch(matcher, { role, tries = 3 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const env = run(["snapshot", "--app", APP, "-i", "--compact", "--timeout-ms=30000"]);
    if (!env.ok) { await2(); continue; }
    const found = walk(env.data.tree, (node) => {
      if (role && node.role !== role) return false;
      return typeof matcher === "string"
        ? String(node.name ?? "").includes(matcher)
        : matcher(node);
    });
    if (found) return { snapshotId: env.data.snapshot_id, node: found, ref: found.ref_id };
    await2();
  }
  return null;
  function await2() { sleep(1200); }
}

function walk(node, predicate) {
  if (predicate(node) && node.ref_id) return node;
  for (const child of node.children ?? []) {
    const hit = walk(child, predicate);
    if (hit) return hit;
  }
  return null;
}

/** All matching nodes in one snapshot (for counts / multi-element checks).
 *  快照失败时返回空集（由调用方断言处理），不抛错。 */
export function snapshotMatchAll(matcher, { role } = {}) {
  const env = run(["snapshot", "--app", APP, "-i", "--compact", "--timeout-ms=30000"]);
  if (!env.ok) return { snapshotId: null, hits: [] };
  const hits = [];
  const walk = (node) => {
    if ((!role || node.role === role) &&
        (typeof matcher === "string"
          ? String(node.name ?? "").includes(matcher)
          : matcher(node)) && node.ref_id) hits.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(env.data.tree);
  return { snapshotId: env.data.snapshot_id, hits };
}

/**
 * Resolve + click with one retry: on stale/ambiguous ref, re-snapshot and
 * re-match, then click the fresh ref.
 */
export async function clickMatch(matcher, { role, tries = 4 } = {}) {
  let lastError = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    ensureVisible();
    const snap = snapshotMatch(matcher, { role, tries: 2 });
    if (!snap?.ref) { lastError = "no snapshot match"; continue; }
    const { snapshotId, node, ref } = snap;
    const env = run(["click", ref]);
    if (env.ok) return { clicked: node.name, snapshotId };
    lastError = `${env.error?.code ?? "CLICK_FAIL"}: ${String(env.error?.message ?? "").slice(0, 140)}`;
    // stale/ambiguous → short pause, fresh snapshot on next attempt
    await sleep(1200);
  }
  throw new Error(`clickMatch failed (${lastError}) for ${typeof matcher === "string" ? matcher : "matcher"}`);
}

/** Poll until a node matching `matcher` appears in the snapshot tree. */
export async function waitMatch(matcher, { role, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = snapshotMatch(matcher, { role, tries: 1 });
    if (hit) return hit.node;
    await sleep(1000);
  }
  throw new Error(`waitMatch timeout (${timeoutMs}ms): ${typeof matcher === "string" ? matcher : "matcher"}`);
}

/** Text presence check against the snapshot tree (name or raw tree JSON). */
export function textPresent(text) {
  const { hits } = snapshotMatchAll(text);
  if (hits.length > 0) return true;
  const env = run(["snapshot", "--app", APP, "--compact", "--timeout-ms=30000"]);
  if (!env.ok) return false;
  try {
    const s = JSON.stringify(env.data.tree);
    return s.includes(text);
  } catch {
    return false;
  }
}

/** Poll until text appears anywhere in the window (default 15s). */
export async function waitText(text, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (textPresent(text)) return true;
    await sleep(800);
  }
  throw new Error(`text not present within ${timeoutMs}ms: ${text}`);
}

/** Screenshot the WeMail window to a PNG file (visual evidence). */
export function screenshot(filePath) {
  return ok(["screenshot", "--app", APP, filePath]);
}

/** Restore + focus the app window (minimized windows break a11y + screenshots). */
export function ensureVisible() {
  try { ok(["restore", "--app", APP]); } catch { /* may already be visible */ }
  try { ok(["focus-window", "--app", APP]); } catch { /* best-effort */ }
  await_window();
}
function await_window() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const env = run(["list-windows", "--app", APP], { timeoutMs: 15_000 });
    if ((env.data ?? []).length > 0) return;
    try { ok(["restore", "--app", APP]); } catch { /* retry */ }
    sleep(800);
  }
}

/** Sequential steps with labels — the observe→act→verify loop runner.
 *  Each step is preceded by ensureVisible so external minimization
 *  (tray behavior / user action) cannot cascade-fail the batch. */
export async function steps(steps) {
  let failed = 0;
  for (const [label, fn] of steps) {
    try {
      ensureVisible();
      await fn();
      console.log(`ok    ${label}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${label} :: ${String(error.message ?? error).slice(0, 300)}`);
    }
  }
  return failed;
}

export function ok(args, { timeoutMs = 90_000 } = {}) {
  const env = run(args, { timeoutMs });
  if (!env.ok) {
    const err = new Error(
      `${env.error?.code ?? "UNKNOWN"}: ${env.error?.message ?? "failed"} (${args.join(" ")})`,
    );
    err.code = env.error?.code;
    throw err;
  }
  return env.data;
}
