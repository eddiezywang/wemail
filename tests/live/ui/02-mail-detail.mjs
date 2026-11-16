// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Live UI batch 2 — mail detail panel: open the first INBOX mail row
// (rows are buttons named `选择邮件 <sender> <date> … <subject>`), verify
// the detail toolbar renders, then restore unread via 标记为未读 (found on
// the row/detail) or skip the restore when the entry is absent. Mutates
// exactly one read-flag and restores it.
import fs from "node:fs";
import { steps, clickMatch, waitMatch, snapshotMatch, snapshotMatchAll, screenshot } from "./lib.mjs";

const EVIDENCE = "E:/temp/wemail-ui-evidence";
fs.mkdirSync(EVIDENCE, { recursive: true });

const failed = await steps([
  ["防御：若设置弹窗未关则先关闭", async () => {
    const open = snapshotMatchAll("高级设置");
    if (open.hits.length > 0) await clickMatch("关闭", { role: "button" });
  }],

  ["收件箱就绪", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],

  ["打开第一封邮件行 → 捕获主题片段 → 详情工具栏渲染", async () => {
    const opened = snapshotMatch("选择邮件", { role: "button", tries: 2 });
    if (!opened?.node) throw new Error("未找到邮件行");
    // 行名形如 "选择邮件 <发件人> <日期> 加星标 移到回收站 标记为已读 <主题>…"
    // 取最后一段（主题）作为唯一标识片段。
    const rowName = String(opened.node.name ?? "");
    globalThis.subjectMarker = rowName.split("标记为已读").pop()?.slice(0, 24) ?? "";
    await clickMatch("选择邮件", { role: "button" });
    await waitMatch("回复", { timeoutMs: 20_000 });
  }],

  ["截图：详情面板", async () => {
    screenshot(`${EVIDENCE}/04-detail.png`);
  }],

  ["详情工具栏动作齐备（列表行动作 + 详情动作合并判定）", async () => {
    const actions = snapshotMatchAll("", { role: "button" });
    const names = actions.hits.map((h) => String(h.name)).join(" ");
    const has = (kw) => names.includes(kw);
    const present = ["回复", "归档", "稍后", "加星标", "标记为未读"].filter(has);
    if (present.length < 2) {
      throw new Error(`工具栏动作不足: ${names.slice(0, 200)}`);
    }
  }],

  ["标记为未读（best-effort 恢复，不计入失败）", async () => {
    const marker = globalThis.subjectMarker ?? "";
    if (!marker) { console.log("      (无主题片段 — 跳过恢复)"); return; }
    const hit = snapshotMatch(
      (node) =>
        String(node.name ?? "").includes("标记为未读") &&
        String(node.name ?? "").includes(marker),
      { role: "button", tries: 2 },
    );
    if (!hit?.ref) { console.log("      (行内未见标记为未读按钮 — 跳过恢复)"); return; }
    const env = (await import("./lib.mjs")).run(["click", hit.ref]);
    console.log(env.ok ? "      已恢复未读" : `      恢复点击未确认 (${env.error?.code}) — 忽略`);
  }],

  ["返回收件箱列表", async () => {
    await clickMatch("收件箱", { role: "link" });
    await waitMatch("写邮件", { role: "button", timeoutMs: 10_000 });
  }],
]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
