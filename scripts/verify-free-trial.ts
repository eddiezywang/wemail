/**
 * 限时免费资源 — 端到端自检：起签发服务 → 客户端申领（名=用户名）→
 * 幂等复用 → 追溯 → 清理。
 *
 * 用法：
 *   WEMAIL_FREE_TRIAL_ADMIN_PASSWORD=<Sub2API管理密码> \
 *   npx tsx scripts/verify-free-trial.ts [username]
 *
 * 凭证只在命令行/环境变量传入，不落盘。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const username = process.argv[2] ?? "verify-user";
const issuerPort = process.env.WEMAIL_FREE_TRIAL_ISSUER_PORT ?? "8799";
const issuerKey = process.env.WEMAIL_FREE_TRIAL_ISSUER_KEY ?? "verify-issuer-key";
const adminPassword = process.env.WEMAIL_FREE_TRIAL_ADMIN_PASSWORD ?? "";
const gatewayBaseUrl =
  (process.env.WEMAIL_FREE_TRIAL_BASE_URL ?? "").replace(/\/+$/, "");

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) process.exitCode = 1;
}

if (!adminPassword) {
  console.error("✗ 缺少 WEMAIL_FREE_TRIAL_ADMIN_PASSWORD（Sub2API 管理密码，仅用于本自检，不落盘）");
  process.exit(1);
}

// ── 1. 起签发服务子进程 ────────────────────────────────────────────
process.env.WEMAIL_FREE_TRIAL_ISSUER_KEY = issuerKey;
process.env.WEMAIL_FREE_TRIAL_ISSUER_PORT = issuerPort;
process.env.WEMAIL_FREE_TRIAL_ADMIN_PASSWORD = adminPassword;
process.env.WEMAIL_FREE_TRIAL_ADMIN_EMAIL = process.env.WEMAIL_FREE_TRIAL_ADMIN_EMAIL ?? "verify@example.com";

const child = spawn(
  process.execPath,
  [resolve(root, "node_modules", "tsx", "dist", "cli.mjs"), resolve(root, "services", "free-trial-issuer", "server.ts")],
  { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
);
child.stderr.on("data", (d) => process.stderr.write(d));
let childLog = "";
child.stdout.on("data", (d) => { childLog += String(d); });

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${issuerPort}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("签发服务未在预期时间内就绪: " + childLog);
}

async function cleanup(): Promise<void> {
  try {
    const login = await fetch(`${gatewayBaseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.WEMAIL_FREE_TRIAL_ADMIN_EMAIL, password: adminPassword }),
    }).then((r) => r.json());
    const token = login?.data?.access_token as string | undefined;
    if (!token) return;
    const list = await fetch(`${gatewayBaseUrl}/api/v1/keys?search=${encodeURIComponent(`wemail-${username}`)}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    for (const item of list?.data?.items ?? []) {
      await fetch(`${gatewayBaseUrl}/api/v1/keys/${item.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      console.log(`  (cleanup) deleted key id=${item.id} name=${item.name}`);
    }
  } catch (e) {
    console.warn("  (cleanup) warning:", e instanceof Error ? e.message : e);
  }
}

try {
  await waitForHealth();
  console.log("✓ 签发服务就绪 (:8799)");

  // ── 2. 客户端申领（模拟机器 A）───────────────────────────────────
  process.env.WEMAIL_FREE_TRIAL_ISSUER_URL = `http://127.0.0.1:${issuerPort}`;
  process.env.WEMAIL_FREE_TRIAL_ISSUER_KEY = issuerKey;
  const { FreeTrialResourceService, sanitizeKeyName } = await import(
    "../server/wemail/activation/freeTrialResource.js"
  );

  const clientA = new FreeTrialResourceService(); // 机器 A
  const first = await clientA.issueKey(username);
  assert(Boolean(first.apiKey), `机器 A 申领成功: ${first.name} → ${first.apiKey.slice(0, 18)}… (过期 ${first.expiresAt}, model=${first.model})`);

  // ── 3. 幂等：机器 B 再次申领 → 复用同一 Key ──────────────────────
  const clientB = new FreeTrialResourceService(); // 机器 B（独立实例）
  const second = await clientB.issueKey(username);
  assert(
    second.apiKey === first.apiKey,
    `幂等：机器 B 复用同一 Key（${second.apiKey.slice(0, 18)}…），未重复创建`,
  );

  // ── 4. 网关侧追溯（按名检索）─────────────────────────────────────
  const login = await fetch(`${gatewayBaseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.WEMAIL_FREE_TRIAL_ADMIN_EMAIL, password: adminPassword }),
  }).then((r) => r.json());
  const token = login?.data?.access_token as string | undefined;
  assert(Boolean(token), "管理账号登录（网关侧追溯用）");
  if (token) {
    const list = await fetch(`${gatewayBaseUrl}/api/v1/keys?search=${encodeURIComponent(first.name)}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const found = (list?.data?.items ?? []).filter((k: { name: string }) => k.name === first.name);
    assert(found.length === 1, `网关侧仅 1 把同名 Key（追溯/幂等双重确认，实际 ${found.length} 把）`);
  }

  console.log("\n配置:", JSON.stringify(FreeTrialResourceService.describe()));
  console.log("sanitize 示例:", sanitizeKeyName("张三@example.com"));
} finally {
  await cleanup();
  child.kill();
}
