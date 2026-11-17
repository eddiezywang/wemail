# 贡献指南 / Contributing

感谢考虑为 WeMail 做贡献！本文档说明开发环境、代码约定与提交流程。

Thanks for considering a contribution to WeMail! This guide covers the
development setup, conventions, and the pull-request process.

## 开发环境 / Development setup

要求：Node.js 22.19+（22.x）或 24.x、Bun（依赖安装）、Windows / macOS / Linux 均可开发；CI 使用 Node 22.x。
桌面打包脚本目前面向 Windows。

```bash
bun install            # 安装依赖
npm run dev:renderer   # Vite 渲染层开发服务器 (:5173)
npm run dev:desktop    # 渲染层 + Electron 主进程并行开发
```

仅调试网页时可运行 `npm run dev:web`，并从 `http://127.0.0.1:5173` 访问。
独立开发 API 限制浏览器来源；若改用其他渲染地址，启动前将
`VITE_DEV_SERVER_URL` 设为该地址，并确保 Vite 实际监听相同地址。

## 常用命令 / Common commands

```bash
npm run typecheck            # 渲染层 TypeScript（react-router typegen + tsc -b）
npm run typecheck:server     # server / shared
npm run typecheck:desktop    # electron / server / shared
npm run test:server:unit     # server 单元测试（node:test，分片）
npm run test:renderer        # 渲染层测试（vitest：node + dom 两个 project）
npm run test:packaging       # 打包与仓库脚本契约测试（CI 应用变更门禁）
npm run check:public-boundary # 开源边界棘轮门禁（verify:pr 的一部分）
npm run verify:pr            # PR 前完整验证链
npm run build:desktop        # 桌面构建（tsc 编译主进程 + 渲染层产物）
```

## 提交前 / Before you open a PR

1. `npm run verify:pr` 全绿（类型、边界门禁、server 与 renderer 测试）。
2. 新功能请附带测试；修 bug 请先加一个能复现问题的失败测试再修。
3. 遵循现有代码风格：TypeScript strict、双空格缩进、双引号；
   server 与渲染层通过 `shared/` 通讯，**`shared/` 不得 import
   server 或渲染层代码**。
4. 提交信息用 conventional 风格（`feat:` / `fix:` / `test:` /
   `chore:` …）。

发布前的开源版人工验收与产物检查见
[open-release-checklist.md](docs/testing/open-release-checklist.md)。

## 项目约定 / Project conventions

- **Agent 不自动发信**：Agent 发信需要用户显式确认；持有 MCP 连接凭据的
  客户端可直接提交发信等写操作，不另弹 WeMail 确认。Agent 运行有硬上限（6 次工具调用 / 单工具 30s /
  单次 120s）。
- **日志与遥测**：不要记录邮件正文、凭据或模型原文。新增日志字段时检查
  `AppLogger` 的脱敏规则，并在分享日志前自行检查；自动脱敏不能保证覆盖所有敏感内容。
  遥测默认关闭。
- **开源边界**：`scripts/check-public-boundary.mjs` 检查已配置的内部信息模式，
  但不能代替人工审查。若你的改动触碰了基线文件
  （`scripts/public-boundary-baseline.json`），必须在 PR 描述里说明
  理由——增长需要审查。
- **本地 API**：渲染层通过本地 Hono API（`/api/...`）和桌面 bridge
  访问应用服务。邮件供应商和配置的模型服务可能位于远端；新增网络访问时应说明数据流和用户选择。

## 报告问题 / Reporting issues

- 功能建议与 bug 请开 GitHub Issue，附复现步骤与日志
  （注意先脱敏：日志里不应包含邮件正文）。
- 安全漏洞走 [SECURITY.md](SECURITY.md) 的私密渠道，不要公开 Issue。

## 许可 / License

贡献默认以 [Apache-2.0](LICENSE) 授权。若你新增的文件源自
[cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox)
上游，请保留其原始版权头和适用的许可声明；修改上游文件时，在文件中
显著标明该文件已被修改。完全自行编写的文件无需添加 Cloudflare 版权头。
