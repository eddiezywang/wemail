// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * 免费额度 — WeMail 客户端侧接入。
 *
 * 本模块只负责调用运营侧签发服务（services/free-trial-issuer）：
 *   POST /issue { username }  + x-issuer-key → { apiKey, expiresAt }
 *
 * 安全模型：Sub2API 管理凭证只存在于运营签发服务，本模块（以及整个
 * WeMail 安装包）不持有任何管理密码或管理 API Key。客户端携带的
 * issuer key 泄露后仅能触发签发，且签发服务按用户名幂等 + 按 IP 限频。
 *
 * 配置解析优先级：环境变量 → build/free-trial-config.json（构建脚本
 * scripts/write-free-trial-config.mjs 生成，仅含 issuerUrl/issuerKey）
 * → 仓库根 .env.local（仅 dev 便利）。
 */

import fs from "node:fs";
import path from "node:path";

const ISSUER_TIMEOUT_MS = 15_000;
/** 首次连通性探测：内网等无法到达签发服务的环境，3s 内快速失败，不必等完整签发超时。 */
const ISSUER_PROBE_TIMEOUT_MS = 3_000;

interface FreeTrialClientConfig {
  issuerUrl: string;
  issuerKey: string;
  model: string;
  groupId: number;
  expiresInDays: number;
  gatewayBaseUrl: string;
  /** 可领取免费额度的邮箱域名白名单（空 = 不限）。 */
  allowedDomains: string[];
}

/** 简单解析 .env.local（KEY=VALUE 行），避免引入 dotenv 运行时依赖。 */
function parseDotEnvLocal(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let content: string;
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

/** 打包产物候选路径：extraResources 复制到 resources/ 根（asar 外）；dev 时读 cwd/build。 */
function packagedJsonCandidates(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates: string[] = [];
  if (resourcesPath) {
    // 本模块在 server 子进程加载，无 Electron asar fs 补丁，读不了 app.asar 内的
    // build/。打包时由 electron-builder extraResources 将配置复制到 resources/ 根，
    // 这里用普通路径读取（与 skills/automation-templates 的 extraResources 模式一致）。
    candidates.push(path.join(resourcesPath, "free-trial-config.json"));
  }
  candidates.push(path.join(process.cwd(), "build", "free-trial-config.json"));
  return candidates;
}

function readFirstPackagedJson(): Record<string, string> {
  for (const candidate of packagedJsonCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" || typeof value === "number") {
          result[key] = String(value);
        }
      }
      return result;
    } catch {
      // 候选不存在 → 继续下一个
    }
  }
  return {};
}

function loadClientConfig(): FreeTrialClientConfig {
  const env = process.env;
  // 优先级：环境变量 > .env.local（dev 最新配置）> build/free-trial-config.json（打包配置）。
  // dev 时 build/ 可能残留旧配置，必须让 .env.local 覆盖它。
  const local = parseDotEnvLocal(path.join(process.cwd(), ".env.local"));
  const packaged = readFirstPackagedJson();
  const get = (envKey: string, jsonKey: string, fallback = ""): string =>
    env[envKey] ?? local[envKey] ?? packaged[jsonKey] ?? fallback;
  return {
    issuerUrl: get("WEMAIL_FREE_TRIAL_ISSUER_URL", "issuerUrl"),
    issuerKey: get("WEMAIL_FREE_TRIAL_ISSUER_KEY", "issuerKey"),
    model: get("WEMAIL_FREE_TRIAL_MODEL", "model", ""),
    groupId: Number(get("WEMAIL_FREE_TRIAL_GROUP_ID", "groupId", "0")),
    expiresInDays: Number(get("WEMAIL_FREE_TRIAL_DAYS", "expiresInDays", "0")),
    gatewayBaseUrl: get("WEMAIL_FREE_TRIAL_BASE_URL", "gatewayBaseUrl"),
    allowedDomains: (get("WEMAIL_FREE_TRIAL_ALLOWED_DOMAINS", "allowedDomains", ""))
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
}

const CLIENT_CONFIG = loadClientConfig();

export interface FreeTrialKey {
  keyId: number;
  apiKey: string;
  name: string;
  expiresAt: string;
  model: string;
  gatewayBaseUrl: string;
}

export class FreeTrialResourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FreeTrialResourceError";
    this.code = code;
  }
}

/** Key 名 = 用户名（由签发服务最终决定；此处保留供校验/展示）。 */
export function sanitizeKeyName(username: string): string {
  const cleaned = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  const truncated = cleaned.slice(0, 40);
  if (!truncated) {
    throw new FreeTrialResourceError("invalid-username", "用户名不能为空");
  }
  return `wemail-${truncated}`;
}

export class FreeTrialResourceService {
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  private get issuerUrl(): string {
    return CLIENT_CONFIG.issuerUrl.replace(/\/+$/, "");
  }

  /**
   * 向运营免费额度服务申领 Key（幂等：同名用户已开通则复用）。
   * 本机不接触 Sub2API 管理凭证。email 用于域名白名单校验（仅限配置允许的邮箱域）。
   */
  async issueKey(username: string, email?: string): Promise<FreeTrialKey> {
    if (!CLIENT_CONFIG.issuerUrl) {
      throw new FreeTrialResourceError("not-configured", "免费额度暂未开放");
    }
    // 先探测连通性：内网等无法到达签发服务的环境 3s 内快速失败，避免用户干等完整签发超时。
    await this.probeConnectivity();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ISSUER_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.issuerUrl}/issue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-issuer-key": CLIENT_CONFIG.issuerKey,
        },
        body: JSON.stringify(email ? { username, email } : { username }),
        signal: controller.signal,
      });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new FreeTrialResourceError("bad-response", "免费额度服务返回了无法解析的响应");
      }
      const payload = parsed as {
        ok?: boolean;
        error?: string;
        apiKey?: string;
        name?: string;
        expiresAt?: string;
        model?: string;
        gatewayBaseUrl?: string;
      };
      if (!response.ok || payload.ok !== true || !payload.apiKey) {
        const code = payload.error ?? "issue-failed";
        if (code === "unauthorized") {
          throw new FreeTrialResourceError(code, "免费额度不可用，请联系管理员");
        }
        if (code === "domain-not-allowed") {
          throw new FreeTrialResourceError(code, "免费额度仅限企业邮箱使用");
        }
        throw new FreeTrialResourceError(code, "暂时无法开通免费额度，请稍后重试");
      }
      return {
        keyId: 0,
        apiKey: payload.apiKey,
        name: payload.name ?? "",
        expiresAt: payload.expiresAt ?? "",
        model: payload.model ?? "",
        gatewayBaseUrl: payload.gatewayBaseUrl ?? "",
      };
    } catch (error) {
      if (error instanceof FreeTrialResourceError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new FreeTrialResourceError("timeout", "开通免费额度超时，请稍后重试");
      }
      throw new FreeTrialResourceError("network", "无法连接免费额度服务");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 轻量连通性探测：HEAD 签发服务根路径，3s 内拿到任意 HTTP 响应（含 404/401/405）
   * 即视为可达。只验证 TCP 连通、不下载正文、不跟随重定向；不通时快速失败。
   */
  private async probeConnectivity(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ISSUER_PROBE_TIMEOUT_MS);
    try {
      await this.fetchImpl(this.issuerUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof FreeTrialResourceError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new FreeTrialResourceError("timeout", "连接免费额度服务超时，请检查网络后重试");
      }
      throw new FreeTrialResourceError("network", "无法连接免费额度服务");
    } finally {
      clearTimeout(timer);
    }
  }

  /** 当前运营配置（仅非敏感字段，供 UI 展示“免费额度”入口）。 */
  static describe(): {
    enabled: boolean;
    model: string;
    groupId: number;
    expiresInDays: number;
    baseUrl: string;
    allowedDomains: string[];
  } {
    return {
      enabled: Boolean(CLIENT_CONFIG.issuerUrl),
      model: CLIENT_CONFIG.model ?? "",
      groupId: CLIENT_CONFIG.groupId ?? 0,
      expiresInDays: CLIENT_CONFIG.expiresInDays ?? 0,
      baseUrl: CLIENT_CONFIG.gatewayBaseUrl ?? CLIENT_CONFIG.issuerUrl,
      allowedDomains: CLIENT_CONFIG.allowedDomains,
    };
  }

  static get model(): string {
    return CLIENT_CONFIG.model ?? "";
  }

  static get baseUrl(): string {
    return CLIENT_CONFIG.issuerUrl;
  }
}
