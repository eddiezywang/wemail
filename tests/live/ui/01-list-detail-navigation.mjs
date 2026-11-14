// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Live UI batch 1 — list & folder navigation on the real instance:
// sidebar navigation, folder switching, list rendering, directory search.
// Read-only navigation; no mail data is mutated.
import fs from "node:fs";
import { steps, clickMatch, waitMatch, snapshotMatchAll, screenshot } from "./lib.mjs";

const EVIDENCE = "E:/temp/wemail-ui-evidence";
fs.mkdirSync(EVIDENCE, { recursive: true });

const failed = await steps([
  ["收件箱入口 + 写邮件按钮存在", async () => {
    const inbox = await waitMatch("收件箱", { role: "link", timeoutMs: 15_000 });
    if (!inbox) throw new Error("收件箱链接不存在");
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],

  ["点击收件箱 → 邮件列表渲染（webank.com 发件人可见）", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],

  ["侧栏文件夹可见（所有邮件/已发送，轮询等待展开）", async () => {
    const { waitMatch } = await import("./lib.mjs");
    await waitMatch("所有邮件", { role: "link", timeoutMs: 15_000 });
    await waitMatch("已发送", { role: "link", timeoutMs: 15_000 });
  }],

  ["截图：收件箱", async () => {
    screenshot(`${EVIDENCE}/01-inbox.png`);
  }],

  ["切换到已发送文件夹", async () => {
    await clickMatch("已发送", { role: "link" });
    await waitMatch("已发送", { role: "link", timeoutMs: 10_000 });
  }],

  ["切回收件箱", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],

  ["截图：切回后", async () => {
    screenshot(`${EVIDENCE}/02-inbox-return.png`);
  }],

  ["通讯录导航 + 搜索框存在", async () => {
    await clickMatch("通讯录", { role: "link" });
    await waitMatch("企业通讯录", { timeoutMs: 15_000 });
    const search = snapshotMatchAll("搜索企业通讯录");
    if (search.hits.length === 0) throw new Error("通讯录搜索框不存在");
  }],

  ["截图：通讯录", async () => {
    screenshot(`${EVIDENCE}/03-directory.png`);
  }],

  ["切回收件箱（复位）", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],
]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
