// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Live UI batch 1 — list & folder navigation on the real instance:
// sidebar navigation is driven by link VALUE (route paths are stable even
// when the embedded renderer port changes), folder switching, list
// rendering, directory search. Read-only navigation.
import fs from "node:fs";
import { steps, clickMatch, waitText, textPresent, snapshotMatchAll, screenshot } from "./lib.mjs";

const EVIDENCE = "E:/temp/wemail-ui-evidence";
fs.mkdirSync(EVIDENCE, { recursive: true });

const failed = await steps([
  ["收件箱入口 + 写邮件按钮存在", async () => {
    const inbox = (await import("./lib.mjs")).snapshotMatchAll("");
    if (!inbox.hits.some((h) => String(h.name ?? "").includes("写邮件"))) {
      throw new Error("写邮件按钮不存在");
    }
    if (!inbox.hits.some((h) => String(h.name ?? "").includes("收件箱"))) {
      throw new Error("收件箱入口不存在");
    }
  }],

  ["点击收件箱 → 邮件列表渲染", async () => {
    await clickMatch((node) =>
      node.role === "link" &&
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(String(node.value ?? "")));
    await waitText("全部标为已读", { timeoutMs: 25_000 });
  }],

  ["侧栏文件夹可见（所有邮件/已发送）", async () => {
    if (!textPresent("所有邮件")) throw new Error("缺少 所有邮件");
    if (!textPresent("已发送")) throw new Error("缺少 已发送");
  }],

  ["截图：收件箱", async () => {
    screenshot(`${EVIDENCE}/01-inbox.png`);
  }],

  ["展开侧栏分组（重启后默认折叠）", async () => {
    const { snapshotMatchAll, run } = await import("./lib.mjs");
    for (let round = 0; round < 4; round++) {
      const expandBtns = snapshotMatchAll("展开", { role: "menubutton" });
      const targets = expandBtns.hits.filter((h) => String(h.name).includes("展开"));
      if (targets.length === 0) break;
      for (const t of targets) run(["click", t.ref_id]);
      await new Promise((r) => setTimeout(r, 800));
    }
  }],

  ["切换到 告警 文件夹（侧栏内名称唯一；已发送为中文孪生链接不可用）", async () => {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await clickMatch((node) =>
          node.role === "link" && String(node.name ?? "").includes("告警"));
        // 文件夹视图渲染证据：列表工具栏或空态
        await waitText("全部标为已读", { timeoutMs: 25_000 });
        return;
      } catch (e) {
        lastErr = String(e).slice(0, 140);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`告警文件夹切换失败: ${lastErr}`);
  }],

  ["切回收件箱（路由 value 匹配）", async () => {
    await clickMatch((node) =>
      node.role === "link" &&
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(String(node.value ?? "")));
    await waitText("全部标为已读", { timeoutMs: 25_000 });
  }],

  ["截图：切回后", async () => {
    screenshot(`${EVIDENCE}/02-inbox-return.png`);
  }],

  ["通讯录导航（路由 value 匹配）+ 搜索框存在", async () => {
    await clickMatch((node) =>
      node.role === "link" && String(node.value ?? "").includes("/directory"));
    await waitText("企业通讯录", { timeoutMs: 15_000 });
    if (snapshotMatchAll("搜索企业通讯录").hits.length === 0) {
      throw new Error("通讯录搜索框不存在");
    }
  }],

  ["截图：通讯录", async () => {
    screenshot(`${EVIDENCE}/03-directory.png`);
  }],

  ["切回收件箱（复位）", async () => {
    await clickMatch((node) =>
      node.role === "link" &&
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(String(node.value ?? "")));
    await waitText("全部标为已读", { timeoutMs: 25_000 });
  }],
]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
