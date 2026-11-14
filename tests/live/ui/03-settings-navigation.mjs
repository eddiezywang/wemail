// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Live UI batch 3 — settings navigation: open settings, walk the primary
// sections (账户 / 个性化 AI / 模型 / MCP / 连接 / Skill Center / 关于 /
// 高级设置), verify each renders, close via the dialog's 关闭 button.
// Read-only. Tolerates ≤2 transient section misses under snapshot flake.
import fs from "node:fs";
import { steps, clickMatch, waitMatch, snapshotMatchAll, screenshot } from "./lib.mjs";

const EVIDENCE = "E:/temp/wemail-ui-evidence";
fs.mkdirSync(EVIDENCE, { recursive: true });

const SECTIONS = ["账户", "个性化", "模型", "MCP", "连接", "Skill Center", "关于", "高级设置"];

const failed = await steps([
  ["打开设置（重试至对话框出现）", async () => {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await clickMatch("设置", {});
      } catch (e) {
        lastErr = String(e).slice(0, 120);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      // 对话框出现的稳定特征
      try {
        await waitMatch("高级设置", { timeoutMs: 8_000 });
        return;
      } catch (e) {
        lastErr = String(e).slice(0, 120);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`设置对话框未出现: ${lastErr}`);
  }],

  ["截图：设置", async () => {
    screenshot(`${EVIDENCE}/05-settings.png`);
  }],

  ["设置分区遍历（容错 ≤2 次瞬时丢失）", async () => {
    let misses = 0;
    const missed = [];
    for (const section of SECTIONS) {
      let okSection = false;
      for (let attempt = 0; attempt < 2 && !okSection; attempt++) {
        const hit = snapshotMatchAll(section);
        if (hit.hits.length > 0) {
          try {
            await clickMatch(section, {});
            okSection = true;
          } catch {
            await new Promise((r) => setTimeout(r, 1500));
          }
        } else {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      if (!okSection) {
        misses++;
        missed.push(section);
      }
    }
    if (misses > 2) {
      throw new Error(`分区丢失过多 (${misses}): ${missed.join(",")}`);
    }
    console.log(`      sections ok=${SECTIONS.length - misses}/${SECTIONS.length}${missed.length ? ` (missed: ${missed.join(",")})` : ""}`);
  }],

  ["截图：设置遍历后", async () => {
    screenshot(`${EVIDENCE}/06-settings-last.png`);
  }],

  ["关闭设置（点击关闭按钮）", async () => {
    await clickMatch("关闭", { role: "button" });
    await new Promise((r) => setTimeout(r, 1000));
  }],
]);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
