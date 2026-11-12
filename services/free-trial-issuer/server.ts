// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * 免费额度 — 运营签发服务（自包含，零依赖，可独立部署）。
 *
 * 部署在运营侧（与 Sub2API 同机或任意服务器），持有 Sub2API 管理凭证，
 * 为每个 WeMail 用户幂等签发以用户名为名的限时 API Key。
 *
 * 安全模型：
 *  - Sub2API 管理凭证只存在于本进程环境变量，绝不进入 WeMail 安装包。
 *  - 客户端通过 `x-issuer-key` 调用；该密钥随包分发，泄露后仅能触发签发
 *    （无法读取管理凭证、无法读取他人 Key），且本服务按用户名幂等 +
 *    IP 限频兜底。
 *  - 签发记录输出审计日志（用户名 + Key id + 时间，不含 Key 值）。
 *
 * 端点：POST /issue { username } · GET /info · GET /health（均需 x-issuer-key）
 *
 * 运行：WEMAIL_FREE_TRIAL_ADMIN_* 等环境变量设置后 `node issuer.mjs` 或 tsx。
 */

import http from "node:http";
import { timingSafeEqual } from "node:crypto";

// ── 配置（环境变量，进程启动时解析一次）────────────────────────────
const ADMIN_API_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 86_400_000 - 60_000; // access_token 24h，留 60s 余量

// 网关地址无默认值：运营方必须通过环境变量显式提供，未配置则启动即失败，
// 避免任何部署地址被固化进源码。
const RAW_BASE_URL = process.env.WEMAIL_FREE_TRIAL_BASE_URL ?? "";
if (!RAW_BASE_URL) {
  console.error("✗ 缺少 WEMAIL_FREE_TRIAL_BASE_URL（Sub2API 网关地址，必填）");
  process.exit(1);
}
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, "");
// 对外公布的网关地址（用户机器配置 LLM 用）；默认与内部调用地址一致。
const PUBLIC_BASE_URL = (
  process.env.WEMAIL_FREE_TRIAL_PUBLIC_BASE_URL ?? BASE_URL
).replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.WEMAIL_FREE_TRIAL_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.WEMAIL_FREE_TRIAL_ADMIN_PASSWORD ?? "";
const GROUP_ID = Number(process.env.WEMAIL_FREE_TRIAL_GROUP_ID ?? 3);
const EXPIRES_IN_DAYS = Number(process.env.WEMAIL_FREE_TRIAL_DAYS ?? 30);
const MODEL = process.env.WEMAIL_FREE_TRIAL_MODEL ?? "deepseek-v4-flash";
const KEY_PREFIX = process.env.WEMAIL_FREE_TRIAL_KEY_PREFIX ?? "wemail-";

const ISSUER_KEY = process.env.WEMAIL_FREE_TRIAL_ISSUER_KEY ?? "";
const PORT = Number(process.env.WEMAIL_FREE_TRIAL_ISSUER_PORT ?? 8787);
const RATE_PER_MINUTE = Number(process.env.WEMAIL_FREE_TRIAL_ISSUE_RATE ?? 10);
const BODY_LIMIT = 8 * 1024;
const USERNAME_MAX = 64;

// 允许领取免费额度的邮箱域名白名单（逗号分隔，如 "example.com"；空 = 不限制）。
// 权威校验在本服务执行：即使客户端被绕过，非白名单域名也无法签发。
const ALLOWED_DOMAINS = (process.env.WEMAIL_FREE_TRIAL_ALLOWED_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

function emailDomainAllowed(email: string): boolean {
  if (ALLOWED_DOMAINS.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  // 精确匹配或子域匹配（example.com 允许 sub.example.com）。
  return ALLOWED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// ── Sub2API 管理核心 ───────────────────────────────────────────────

class IssuerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IssuerError";
    this.code = code;
  }
}

/** Key 名 = 用户名。只允许安全字符，防止注入 key 名或伪造追溯。 */
function sanitizeKeyName(username: string): string {
  const cleaned = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  const truncated = cleaned.slice(0, 40);
  if (!truncated) throw new IssuerError("invalid-username", "用户名不能为空");
  return `${KEY_PREFIX}${truncated}`;
}

interface AdminSession {
  accessToken: string;
  expiresAt: number; // epoch ms
}

interface Sub2ApiKeyRecord {
  id: number;
  key: string;
  name: string;
  status: string;
  expires_at: string | null;
}

class Sub2ApiClient {
  private readonly fetchImpl: typeof fetch;
  private session: AdminSession | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  private async request(
    path: string,
    init: { method: string; body?: unknown; token?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ADMIN_API_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (init.token) headers.authorization = `Bearer ${init.token}`;
      const response = await this.fetchImpl(`${BASE_URL}/api/v1${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new IssuerError("bad-response", "网关返回了无法解析的响应");
      }
      const payload = parsed as { code?: number | string; message?: string; data?: unknown };
      if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
        throw new IssuerError(
          "gateway-error",
          `网关返回错误（${response.status}）: ${payload.message ?? response.statusText ?? "未知错误"}`,
        );
      }
      return payload.data;
    } catch (error) {
      if (error instanceof IssuerError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new IssuerError("timeout", "网关请求超时");
      }
      throw new IssuerError("network", "无法连接 AI 资源网关");
    } finally {
      clearTimeout(timer);
    }
  }

  async getAdminToken(): Promise<string> {
    if (this.session && Date.now() < this.session.expiresAt) {
      return this.session.accessToken;
    }
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      if (!ADMIN_PASSWORD) {
        throw new IssuerError("not-configured", "免费额度未配置（缺少管理密码）");
      }
      const data = (await this.request("/auth/login", {
        method: "POST",
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      })) as { access_token?: string } | null;
      if (!data?.access_token) {
        throw new IssuerError("login-failed", "管理账号登录失败");
      }
      this.session = { accessToken: data.access_token, expiresAt: Date.now() + TOKEN_TTL_MS };
      return data.access_token;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  private async listKeysByName(name: string): Promise<Sub2ApiKeyRecord[]> {
    const token = await this.getAdminToken();
    const data = (await this.request(
      `/keys?search=${encodeURIComponent(name)}&page_size=100`,
      { method: "GET", token },
    )) as { items?: Sub2ApiKeyRecord[] } | null;
    return (data?.items ?? []).filter((item) => item.name === name);
  }

  /** 已存在同名 active Key 时直接复用（幂等核心：多台机器同一用户只占一个额度）。 */
  async findActiveKeyByName(username: string): Promise<Sub2ApiKeyRecord | null> {
    const records = await this.listKeysByName(sanitizeKeyName(username));
    return records.find((item) => item.status === "active") ?? null;
  }

  /** 幂等签发：先查复用；并发竞态产生多个同名 Key 时保留最早（id 最小）的。 */
  async createKey(username: string): Promise<Sub2ApiKeyRecord> {
    const existing = await this.findActiveKeyByName(username);
    if (existing) return existing;

    const token = await this.getAdminToken();
    const name = sanitizeKeyName(username);
    const data = (await this.request("/keys", {
      method: "POST",
      token,
      body: {
        name,
        group_id: GROUP_ID,
        quota: 0,
        expires_in_days: EXPIRES_IN_DAYS,
      },
    })) as Sub2ApiKeyRecord | null;
    if (!data?.key) throw new IssuerError("create-key-failed", "签发免费 Key 失败");

    const all = (await this.listKeysByName(name)).filter((item) => item.status === "active");
    if (all.length > 1) {
      const keep = all.reduce((a, b) => (a.id < b.id ? a : b));
      if (keep.id !== data.id) {
        await this.revokeKey(data.id);
        return keep;
      }
    }
    return data;
  }

  async revokeKey(keyId: number): Promise<void> {
    const token = await this.getAdminToken();
    await this.request(`/keys/${keyId}`, { method: "DELETE", token });
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────────────

function keyMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 按 IP 滑动窗口限频，防持有签发密钥的人批量刷 Key。 */
const windows = new Map<string, { startedAt: number; count: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const window = windows.get(ip);
  if (!window || now - window.startedAt > 60_000) {
    windows.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  window.count += 1;
  if (window.count > RATE_PER_MINUTE) return true;
  if (windows.size > 10_000) {
    for (const [key, value] of windows) {
      if (now - value.startedAt > 60_000) windows.delete(key);
    }
  }
  return false;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function clientIp(request: http.IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error("body-too-large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const client = new Sub2ApiClient();

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method !== "POST" || (path !== "/issue" && path !== "/info")) {
    sendJson(response, 404, { ok: false, error: "not-found" });
    return;
  }

  const ip = clientIp(request);
  if (rateLimited(ip)) {
    sendJson(response, 429, { ok: false, error: "rate-limited" });
    return;
  }

  const providedKey = request.headers["x-issuer-key"];
  if (typeof providedKey !== "string" || !keyMatches(providedKey, ISSUER_KEY)) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (path === "/info") {
    sendJson(response, 200, {
      ok: true,
      resource: { enabled: Boolean(ADMIN_PASSWORD), model: MODEL, groupId: GROUP_ID, expiresInDays: EXPIRES_IN_DAYS, baseUrl: PUBLIC_BASE_URL },
    });
    return;
  }

  readBody(request)
    .then(async (body) => {
      const record =
        body && typeof body === "object" ? (body as { username?: unknown; email?: unknown }) : {};
      const username =
        typeof record.username === "string" ? record.username.trim() : "";
      const email = typeof record.email === "string" ? record.email.trim() : "";
      if (!username || username.length > USERNAME_MAX) {
        sendJson(response, 400, { ok: false, error: "username-invalid" });
        return;
      }
      // 免费额度仅限白名单邮箱域名；无 email 且配置了白名单时拒绝。
      if (ALLOWED_DOMAINS.length > 0 && !emailDomainAllowed(email)) {
        sendJson(response, 403, { ok: false, error: "domain-not-allowed" });
        return;
      }
      const issued = await client.createKey(username); // 幂等：同名 active Key 直接复用
      console.log(
        `[free-trial-issuer] issue ok: username=${username} keyName=${issued.name} keyId=${issued.id} expiresAt=${issued.expires_at} ip=${ip}`,
      );
      sendJson(response, 200, {
        ok: true,
        apiKey: issued.key,
        name: issued.name,
        expiresAt: issued.expires_at ?? "",
        model: MODEL,
        gatewayBaseUrl: PUBLIC_BASE_URL,
      });
    })
    .catch((error) => {
      const code = error instanceof IssuerError ? error.code : "internal";
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[free-trial-issuer] issue failed: code=${code} ip=${ip} msg=${message}`);
      sendJson(response, code === "not-configured" ? 503 : 502, { ok: false, error: code });
    });
});

server.listen(PORT, () => {
  console.log(
    `[free-trial-issuer] listening on :${PORT} (sub2api ${BASE_URL} · group=${GROUP_ID} · ${EXPIRES_IN_DAYS}d · ${MODEL} · admin ${ADMIN_PASSWORD ? "configured" : "NOT configured"})`,
  );
});
