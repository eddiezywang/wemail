#!/usr/bin/env node
/**
 * 构建期生成 build/free-trial-config.json（限时免费资源客户端配置）。
 *
 * 值来源（优先级）：环境变量 → 仓库根 .env.local → 空。
 * 打包时该文件随 build/** 进入安装包，运行时由
 * server/wemail/activation/freeTrialResource.ts 读取（env 优先于文件）。
 *
 * 安全边界：本文件只含签发服务地址 + issuer key（客户端鉴权用），
 * 绝不含 Sub2API 管理凭证 — 管理凭证只存在于运营签发服务
 * （services/free-trial-issuer）的服务器环境变量中。
 * issuer key 泄露只能触发签发（签发服务侧按用户名幂等 + IP 限频），
 * 无法读取管理凭证或他人 Key。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "build", "free-trial-config.json");

// 与 server 端 .env.local 解析保持一致的简易读取（避免 dotenv 依赖）。
function readDotEnvLocal(filePath) {
  const result = {};
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return result;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

const envLocal = readDotEnvLocal(path.join(root, ".env.local"));
const pick = (envKey) => process.env[envKey] ?? envLocal[envKey] ?? "";

const config = {
  issuerUrl: pick("WEMAIL_FREE_TRIAL_ISSUER_URL"),
  issuerKey: pick("WEMAIL_FREE_TRIAL_ISSUER_KEY"),
  // 非敏感展示信息（与签发服务配置同源；UI 用于展示 model / 限时天数）
  model: pick("WEMAIL_FREE_TRIAL_MODEL") || "deepseek-v4-flash",
  groupId: Number(pick("WEMAIL_FREE_TRIAL_GROUP_ID") || 3),
  expiresInDays: Number(pick("WEMAIL_FREE_TRIAL_DAYS") || 30),
  gatewayBaseUrl: pick("WEMAIL_FREE_TRIAL_BASE_URL"),
  allowedDomains: pick("WEMAIL_FREE_TRIAL_ALLOWED_DOMAINS"),
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(config)}\n`, { mode: 0o600 });
const enabled = Boolean(config.issuerUrl && config.issuerKey);
process.stdout.write(
  `[free-trial-config] wrote ${output} (${enabled ? "issuer configured" : "free trial DISABLED (no issuer)"})\n`,
);
