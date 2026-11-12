import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const websiteRoot = path.resolve(import.meta.dirname, "..");

async function readGuide() {
  const guide = await readFile(
    path.join(
      websiteRoot,
      "src",
      "content",
      "docs",
      "getting-started",
      "connect-mailbox.md",
    ),
    "utf8",
  );
  return guide.replace(/\r\n/g, "\n");
}

function findTableRow(guide, label) {
  const row = guide.split("\n").find((line) => line.startsWith("|") && line.includes(label));
  assert.ok(row, "Missing provider row: " + label);
  return row;
}

test("mailbox guide lists the exact supported provider endpoints and encryption modes", async () => {
  const guide = await readGuide();
  const rows = [
    {
      label: "163 邮箱 (`163.com`)",
      tokens: ["imap.163.com:993", "smtp.163.com:465", "SSL/TLS", "16 位授权码"],
    },
    {
      label: "126 邮箱 (`126.com`)",
      tokens: ["imap.126.com:993", "smtp.126.com:465", "SSL/TLS", "授权码"],
    },
    {
      label: "QQ / Foxmail (`qq.com` / `foxmail.com`)",
      tokens: ["imap.qq.com:993", "smtp.qq.com:465", "SSL/TLS", "授权码"],
    },
    {
      label: "Gmail (`gmail.com` / `googlemail.com`)",
      tokens: ["imap.gmail.com:993", "smtp.gmail.com:465", "SSL/TLS", "应用专用密码"],
    },
    {
      label: "Outlook / Hotmail / Live",
      tokens: ["outlook.office365.com:993", "smtp.office365.com:587", "SSL/TLS", "STARTTLS"],
    },
    {
      label: "iCloud (`icloud.com` / `me.com` / `mac.com`)",
      tokens: ["imap.mail.me.com:993", "smtp.mail.me.com:587", "SSL/TLS", "STARTTLS", "应用专用密码"],
    },
    {
      label: "自定义 IMAP/SMTP",
      tokens: ["默认 `993`", "默认 `465`", "SSL/TLS", "STARTTLS", "管理员"],
    },
  ];

  for (const { label, tokens } of rows) {
    const row = findTableRow(guide, label);
    for (const token of tokens) {
      assert.ok(row.includes(token), label + " is missing: " + token);
    }
  }
});

test("mailbox guide explains preset selection, credentials, troubleshooting, and secret handling", async () => {
  const guide = await readGuide();
  assert.match(guide, /邮箱域名[\s\S]*预设/);
  assert.match(guide, /没有匹配[\s\S]*自定义 IMAP\/SMTP/);
  assert.match(guide, /用户名[\s\S]*完整邮箱地址/);
  assert.match(guide, /授权码[\s\S]*登录密码/);
  assert.match(guide, /两步验证[\s\S]*应用专用密码/);
  assert.match(guide, /连接失败/);
  assert.match(guide, /端口[\s\S]*加密方式/);
  assert.match(guide, /开启 IMAP\/SMTP/);
  assert.match(guide, /防火墙[\s\S]*代理/);
  assert.match(guide, /安全策略|安全拦截/);
  assert.match(guide, /日志[\s\S]*截图/);
  assert.match(guide, /优先使用[\s\S]*(授权码|应用专用密码)/);
});
