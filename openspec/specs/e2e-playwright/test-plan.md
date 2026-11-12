# Package M 重构：浏览器端 E2E + Renderer 测试方案

## 设计理念

**核心思路**：脱离 Electron，用 Playwright 直接驱动 Chromium 浏览器 + 真实 Hono API 服务器。

项目已有的基础设施完美支持这种分离：
- `composeApp()` 可以独立于 Electron 运行，接受 `overrides.mailProviderFactory` 注入 `FileInjectedMailProvider`
- `startLocalApiServer()` 可以在任意端口启动完整的 Hono API
- `FileInjectedMailProvider` 已支持从 JSON 文件读取 mock 邮件
- `WEMAIL_LLM_BASE_URL` 已支持 LLM 流量 mock
- 前端 `api.ts` 通过 `window.wemailDesktop.apiBaseUrl` 检测 API 地址，测试时注入即可

```
┌─────────────────────────────────────────────────┐
│  Playwright (Chromium)                          │
│  ┌───────────────────────────────────────────┐  │
│  │  React Renderer (Vite dev server :5173)   │  │
│  │  window.wemailDesktop.apiBaseUrl = ...    │  │
│  └──────────────┬────────────────────────────┘  │
│                 │ fetch /api/*                   │
│  ┌──────────────▼────────────────────────────┐  │
│  │  Hono API Server (port 0, 真实 composeApp) │  │
│  │  ├─ AccountService                        │  │
│  │  ├─ DB Service mail API + FileInjectedProvider │  │
│  │  ├─ MailIntelligenceBus + QueueRunner     │  │
│  │  ├─ SummaryProcessor / TagProcessor / ... │  │
│  │  └─ PiAgentRuntime + MailAgentTools       │  │
│  └──────────────┬────────────────────────────┘  │
│                 │ HTTP                           │
│  ┌──────────────▼────────────────────────────┐  │
│  │  Mock LLM Server (startMockLlm)           │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**与原方案的对比**：

| 维度 | 原方案 (Electron driver) | 新方案 (Browser + Hono) |
|------|--------------------------|------------------------|
| 启动速度 | 8-15s (Electron 启动) | 2-3s (Chromium + Hono) |
| better-sqlite3 重建 | 需要每次 rebuild | 不需要，Node 原生运行 |
| AI 可操作性 | 截图 + DOM，但需穿透 Electron | 原生 Playwright，截图/DOM/网络全透明 |
| 调试体验 | 需 Electron DevTools | 标准 Chrome DevTools |
| 覆盖范围 | 含 Electron 壳子 | 不含 Electron 壳子 |
| 测试稳定性 | 依赖 Electron 进程管理 | 标准 Web 测试，更稳定 |

## 修改清单

### 1. 新建测试基础设施

#### `tests/browser/helpers/testServer.ts` — 启动独立 Hono API 服务器

```ts
// 核心逻辑：脱离 Electron，直接调用 composeApp + startLocalApiServer
export async function startTestServer(opts: {
  inboxFixtures?: string[];
  llmResponder?: (body: unknown) => string;
}): Promise<{
  apiBaseUrl: string;
  dataDir: string;
  close: () => Promise<void>;
}>
```

复用现有代码：
- `composeApp()` from `server/wemail/bootstrap/AppComposition.js`
- `startLocalApiServer()` from `server/api/app.js`
- `FileInjectedMailProvider` from `server/wemail/mail/FileInjectedMailProvider.js`
- `startMockLlm()` 逻辑直接从 `tests/e2e/helpers/electronApp.ts` 搬过来

#### `tests/browser/helpers/testFixture.ts` — Playwright test fixture

```ts
// 扩展 Playwright test，注入 apiBaseUrl 和辅助方法
import { test as base } from '@playwright/test';

type TestFixture = {
  apiBaseUrl: string;
  dataDir: string;
  login: () => Promise<void>;
  syncMail: () => Promise<void>;
};

export const test = base.extend<TestFixture>({ ... });
```

关键：在 `test.beforeAll` 中启动 Hono 服务器和 mock LLM，在 `test.afterAll` 中关闭。在浏览器页面加载前，通过 `page.addInitScript` 注入 `window.wemailDesktop`。

#### `tests/browser/helpers/mockDesktop.ts` — 注入 window.wemailDesktop

```ts
// 在页面加载前注入，让 api.ts 走桌面模式
export function injectDesktopApi(page: Page, apiBaseUrl: string) {
  page.addInitScript((baseUrl) => {
    window.wemailDesktop = { apiBaseUrl: baseUrl };
  }, apiBaseUrl);
}
```

### 2. Playwright 配置调整

#### `playwright.browser.config.ts` — 新增浏览器 E2E 配置

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  fullyParallel: false,  // SQLite 不支持并发写入
  retries: 0,
  workerCount: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:5173',  // Vite dev server
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:renderer',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

保留原 `playwright.config.ts` 给 Electron E2E（如有需要），新增此配置给浏览器测试。

### 3. E2E 测试用例

#### `tests/browser/01-login.spec.ts` — 登录流程

测试步骤：
1. 访问首页，验证未登录状态（空邮箱列表）
2. 填写 IMAP/SMTP 配置并提交
3. 验证登录成功，侧边栏显示邮箱
4. 验证 API 返回 account 信息

#### `tests/browser/02-sync-summary.spec.ts` — 邮件同步 + AI 摘要

测试步骤：
1. 登录 + mock-inbox 包含 1 封邮件
2. 等待同步完成，邮件列表显示 1 封
3. 点击邮件，打开详情面板
4. 等待 AI 处理完成，EmailSummaryCard 显示摘要要点
5. 验证摘要内容（3 个 bullets）

#### `tests/browser/03-tag-reject.spec.ts` — 智能标签 + 拒绝反馈

测试步骤：
1. 登录 + mock-inbox + LLM mock 返回 tags
2. 邮件详情显示 EmailSmartTags 组件
3. 点击"拒绝"某个标签
4. 验证标签消失
5. 通过 API 验证 mail_tag_feedback_rules 写入

#### `tests/browser/04-reply-draft.spec.ts` — 智能草稿

测试步骤：
1. 登录 + mock-inbox + LLM mock 返回 replyDraft
2. 邮件详情显示 SmartDraftPanel
3. 编辑草稿内容
4. 点击"发送"按钮（验证不自动发送，需确认）
5. 通过 API 验证 draft feedback 写入

#### `tests/browser/05-settings.spec.ts` — LLM 设置页面

测试步骤：
1. 登录
2. 导航到 Settings 页面
3. 修改 LLM API Key 和 Base URL
4. 保存设置
5. 验证 API 返回更新后的配置（key 不回显）

#### `tests/browser/06-agent-chat.spec.ts` — Agent 对话

测试步骤：
1. 登录 + mock-inbox
2. 打开 Agent 面板
3. 发送 "帮我查看最近的邮件"
4. 验证 Agent 返回工具调用结果
5. 如果涉及 WeCLI mutation，验证出现确认对话框

### 4. Renderer 组件测试扩展

现有 4 个组件测试（EmailSmartTags、EmailSummaryCard、SmartDraftPanel、AgentActionConfirmDialog），需扩展到 ≥10 个。新增：

| 组件 | 测试文件 | 测试要点 |
|------|---------|---------|
| Sidebar | `Sidebar.test.tsx` | 文件夹列表渲染、选中态、未读计数 |
| EmailPanel | `EmailPanel.test.tsx` | 邮件详情渲染、发件人/收件人、时间格式化 |
| MailboxSplitView | `MailboxSplitView.test.tsx` | 左右分栏、邮件选中切换 |
| ComposePanel | `ComposePanel.test.tsx` | 收件人输入、主题、正文编辑 |
| IntelligenceStatus | `IntelligenceStatus.test.tsx` | pending/success/failed 状态切换 |
| QueueStatusBadge | `QueueStatusBadge.test.tsx` | 队列空/处理中/有失败 |

### 5. npm scripts 更新

在 `package.json` 中新增：

```json
{
  "test:browser": "playwright test --config playwright.browser.config.ts",
  "test:browser:headed": "playwright test --config playwright.browser.config.ts --headed",
  "test:browser:ui": "playwright test --config playwright.browser.config.ts --ui"
}
```

更新 `test:all`：

```json
{
  "test:all": "typecheck:server && typecheck:desktop && test:server && test:renderer && test:browser"
}
```

## 文件清单

### 新建文件

```
tests/
├── browser/
│   ├── helpers/
│   │   ├── testServer.ts       # Hono 服务器启动 + mock LLM
│   │   ├── testFixture.ts      # Playwright test fixture 扩展
│   │   └── mockDesktop.ts      # window.wemailDesktop 注入
│   ├── 01-login.spec.ts
│   ├── 02-sync-summary.spec.ts
│   ├── 03-tag-reject.spec.ts
│   ├── 04-reply-draft.spec.ts
│   ├── 05-settings.spec.ts
│   └── 06-agent-chat.spec.ts
├── renderer/
│   ├── Sidebar.test.tsx
│   ├── EmailPanel.test.tsx
│   ├── MailboxSplitView.test.tsx
│   ├── ComposePanel.test.tsx
│   ├── IntelligenceStatus.test.tsx
│   └── QueueStatusBadge.test.tsx
playwright.browser.config.ts
```

### 修改文件

```
package.json            # 新增 test:browser 等脚本
vitest.config.ts        # 确认 include 覆盖新 renderer 测试
```

### 不动的文件

```
tests/e2e/              # 保留原有 Electron E2E 测试，不删除
playwright.config.ts    # 保留原有 Electron Playwright 配置
scripts/run-e2e.mjs     # 保留
```

## 实施顺序

1. **搭建基础设施**（testServer + testFixture + mockDesktop + playwright.browser.config.ts）
2. **跑通第一个测试**（01-login），验证端到端通路
3. **逐个添加 E2E 测试**（02-06）
4. **扩展 Renderer 组件测试**（新增 6 个 .test.tsx）
5. **更新 npm scripts**
6. **验证**：所有测试绿色，无外部网络调用

## AI 驱动测试的优势

这套方案特别适合 AI 接管测试：

1. **Playwright 原生交互** — AI agent 可以截图查看 UI 状态、点击按钮、输入文字、等待元素出现，全部通过标准 Playwright API
2. **确定性 Mock** — LLM 和 IMAP 都 mock 了，测试结果稳定可重复
3. **快速反馈** — 2-3 秒启动，AI 可以高频跑测试迭代
4. **自然语言 → 测试用例** — "用户登录后收到新邮件应该自动生成摘要" 可以直接翻译成 02-sync-summary.spec.ts
5. **失败诊断** — AI 看截图 + DOM + 网络请求，快速定位问题
