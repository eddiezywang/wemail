# 限时免费资源 — 运营签发服务

为每个 WeMail 用户**幂等签发**以用户名为名的限时 API Key（Sub2API `openai` 分组）。

**安全模型**：Sub2API 管理凭证只存在于本服务的环境变量，**绝不进入 WeMail 安装包**。
客户端（WeMail）只持有签发服务地址 + issuer key；issuer key 泄露仅能触发签发
（无法读取管理凭证/他人 Key），且本服务按用户名幂等 + IP 限频兜底。

## 部署

### Docker（推荐，部署在 Sub2API 同机）

```bash
docker build -f services/free-trial-issuer/Dockerfile -t wemail-free-trial-issuer .
docker run -d --name free-trial-issuer --restart unless-stopped -p 8787:8787 \
  -e WEMAIL_FREE_TRIAL_ISSUER_KEY='<签发密钥，客户端同值>' \
  -e WEMAIL_FREE_TRIAL_BASE_URL='https://gateway.example.com' \
  -e WEMAIL_FREE_TRIAL_ADMIN_EMAIL='<Sub2API 管理账号>' \
  -e WEMAIL_FREE_TRIAL_ADMIN_PASSWORD='<Sub2API 管理密码>' \
  -e WEMAIL_FREE_TRIAL_GROUP_ID=3 \
  -e WEMAIL_FREE_TRIAL_DAYS=30 \
  -e WEMAIL_FREE_TRIAL_MODEL='deepseek-v4-flash' \
  wemail-free-trial-issuer
```

### 直接跑源码

```bash
WEMAIL_FREE_TRIAL_ISSUER_KEY=... \
WEMAIL_FREE_TRIAL_ADMIN_PASSWORD=... \
npx tsx services/free-trial-issuer/server.ts
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `WEMAIL_FREE_TRIAL_ISSUER_KEY` | ✅ | 签发服务鉴权密钥（WeMail 客户端同值，随包分发） |
| `WEMAIL_FREE_TRIAL_ADMIN_PASSWORD` | ✅ | Sub2API 管理密码（**只在此服务器**，不进安装包） |
| `WEMAIL_FREE_TRIAL_BASE_URL` | ✅ | Sub2API 网关地址（必填，无默认值，例如 `https://gateway.example.com`） |
| `WEMAIL_FREE_TRIAL_ADMIN_EMAIL` | 否 | Sub2API 管理账号（默认 `eddzyw@gmail.com`） |
| `WEMAIL_FREE_TRIAL_GROUP_ID` | 否 | Key 绑定的分组（默认 `3` = openai） |
| `WEMAIL_FREE_TRIAL_DAYS` | 否 | 限时有效天数（默认 `30`） |
| `WEMAIL_FREE_TRIAL_MODEL` | 否 | 默认模型（默认 `deepseek-v4-flash`） |
| `WEMAIL_FREE_TRIAL_ISSUER_PORT` | 否 | 监听端口（默认 `8787`） |
| `WEMAIL_FREE_TRIAL_ISSUE_RATE` | 否 | 每 IP 每分钟签发上限（默认 `10`） |

## 端点

- `POST /issue` `{ username }` + `x-issuer-key` → `{ apiKey, name, expiresAt, model, gatewayBaseUrl }`（幂等）
- `GET /info` + `x-issuer-key` → 非敏感运营信息（UI 展示）
- `GET /health` → `{ ok: true }`

## 运维

- **吊销用户额度**：在 Sub2API 后台按 `wemail-<用户名>` 搜索并删除/停用该 Key（Key 名 = 用户名）。
- **审计**：服务日志输出每笔签发（用户名 + Key id + 时间，不含 Key 值）。
- **密钥轮换**：改 `WEMAIL_FREE_TRIAL_ISSUER_KEY` 后需重新构建分发 WeMail 客户端（或让旧密钥宽限期并存）。
- 生产建议放在 HTTPS 反向代理（nginx/caddy）后面。
