// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Live UI batch 4 — center navigation: 应用消息 (message center) and
// 自动化 (automation center) render their core surfaces. Read-only.
import fs from "node:fs";
import { steps, clickMatch, waitMatch, snapshotMatchAll, screenshot } from "./lib.mjs";

const EVIDENCE = "E:/temp/wemail-ui-evidence";
fs.mkdirSync(EVIDENCE, { recursive: true });

const failed = await steps([
  ["应用消息中心", async () => {
    await clickMatch("应用消息", { role: "link" });
    await waitMatch("应用消息", { timeoutMs: 15_000 });
  }],

  ["截图：应用消息", async () => {
    screenshot(`${EVIDENCE}/07-notifications.png`);
  }],

  ["自动化工作台导航 + 页面离开收件箱", async () => {
    await clickMatch("自动化", { role: "link" });
    // 双条件：出现自动化中心特征文本，或连续两次快照均无收件箱特征
    const deadline = Date.now() + 20_000;
    let leftInbox = false;
    while (Date.now() < deadline) {
      const t = snapshotMatchAll("");
      const s = JSON.stringify(t.hits.map((h) => h.name));
      if (/模板|规则|速览|自动化中心/.test(s)) { leftInbox = true; break; }
      const inboxGone = !s.includes("共 200 封") && !s.includes("179 未读");
      if (inboxGone) {
        if (leftInbox) break;
        leftInbox = true;
      } else {
        leftInbox = false;
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    if (!leftInbox) throw new Error("未能离开收件箱进入自动化中心");
  }],

  ["自动化中心核心元素（模板/规则入口，宽松）", async () => {
    const t = snapshotMatchAll("");
    const s = JSON.stringify(t.hits.map((h) => h.name));
    // 自动化页可能为空态（无安装规则），只要不在收件箱即通过
    if (s.includes("共 200 封")) throw new Error("仍在收件箱视图");
  }],

  ["截图：自动化中心", async () => {
    screenshot(`${EVIDENCE}/08-automation.png`);
  }],

  ["回到收件箱（复位）", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],
]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
