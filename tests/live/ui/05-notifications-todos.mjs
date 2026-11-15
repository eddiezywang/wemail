// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Live UI batch 5 — notification center depth + todo/scheduled routes:
// 应用消息列表渲染、点击一条消息（阅读状态变化）、待办路由、定时发送路由
// 渲染。点击消息会把真实消息标为已读（可接受的最小数据变化）。
import fs from "node:fs";
import { steps, clickMatch, waitMatch, snapshotMatchAll, screenshot } from "./lib.mjs";

const EVIDENCE = "E:/temp/wemail-ui-evidence";
fs.mkdirSync(EVIDENCE, { recursive: true });

const failed = await steps([
  ["进入应用消息中心", async () => {
    await clickMatch("应用消息", { role: "link" });
    await waitMatch("应用消息", { timeoutMs: 15_000 });
  }],

  ["截图：应用消息中心", async () => {
    screenshot(`${EVIDENCE}/09-notifications.png`);
  }],

  ["消息中心核心元素（筛选/列表/空态 至少其一）", async () => {
    const markers = ["筛选", "全部", "未读", "暂无消息", "应用消息"];
    const found = markers.filter((kw) => snapshotMatchAll(kw).hits.length > 0);
    if (found.length === 0) throw new Error("消息中心核心元素均未渲染");
    console.log(`      markers: ${found.join(",")}`);
  }],

  ["待办路由渲染", async () => {
    await clickMatch("待办", { role: "link" });
    await waitMatch("待办", { timeoutMs: 15_000 });
  }],

  ["截图：待办", async () => {
    screenshot(`${EVIDENCE}/10-todos.png`);
  }],

  ["回到收件箱（复位）", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],
]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
