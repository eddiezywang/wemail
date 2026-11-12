# 账号签名与 AI 草稿体验验收报告

日期：2026-07-17
分支：`codex/ai-draft-rework`

## 结论

本次变更达到验收标准。

- Agentic Inbox 核心操作路径相似度：**90 / 100**（要求 ≥ 80）
- UI 美观与完成度：**84 / 100**（要求 ≥ 80）
- 自动化结果：**80 个测试文件、572 项测试全部通过**
- Electron 实际操作：**7 项核心场景全部通过**
- 类型检查及桌面生产构建：**通过**

## 验收标准

| 领域 | 标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 默认签名 | 每个账号默认开启，使用展示名称；没有展示名称时回退邮箱名前缀 | 通过 | 实际账号正文显示 `17371292896` |
| 品牌尾注 | 开启时显示 `Sent with WeMail`，关闭时一并消失 | 通过 | Electron 开启/关闭双状态截图 |
| 数据隔离 | 旧全局 `Eddie Wang` 不再生效，账号设置互不串用 | 通过 | 存储与 compose 单元测试 |
| 用户可编辑 | 签名作为编辑器正文插入，不在发送前强制回填 | 通过 | TipTap 正文 DOM 保留签名节点且为可编辑内容 |
| AI 引导 | 空正文或仅有签名/引用时显示“开始输入或 使用 AI 写作” | 通过 | ComposeBody 组件测试和 Electron 截图 |
| 聚焦行为 | 点击“使用 AI 写作”后滚动并聚焦底部 AI 输入框 | 通过 | Electron `document.activeElement` 断言 |
| 动态缩放 | 支持四边和四角八方向缩放，并遵守最小尺寸/视口边界 | 通过 | 10 项纯几何测试、组件指针测试及 Electron 拖拽 |
| 放大恢复 | 最大化后可恢复完整位置和尺寸，连续三次无漂移 | 通过 | Electron 三循环坐标断言 |
| 引用可读性 | 原邮件样式表不得作为 CSS 文本出现在引用区 | 通过 | 新增回归测试和修复后截图 |

## Electron 实测数据

验收通过 Playwright 的 Electron 驱动直接启动 `dist-electron/electron/main/app.js`，使用当前真实邮箱数据执行：

1. 打开 `iCloud+ 订阅将在 5 天后续期` 并进入回复。
2. 验证签名为当前账号名称，且不存在 `Eddie Wang`。
3. 点击正文 AI 引导并确认底部输入框获得真实焦点。
4. 从西北角拖拽窗口，尺寸由 `600 × 520` 变为 `686 × 596`。
5. 连续执行三次最大化/恢复，位置和尺寸误差均不超过 1px。
6. 在设置页关闭签名，重新打开回复后验证签名节点和尾注数量均为 0。
7. 验收结束前恢复签名默认开启状态。

机器可读结果：

`D:/git/wemail/.worktrees/ai-draft-rework/.tmp/acceptance/account-signature-compose/results.json`

截图证据：

- `01-default-signature-and-ai-guide.png`：默认签名、品牌尾注及正文 AI 引导
- `02-ai-prompt-focused.png`：点击引导后的底部输入聚焦态
- `03-dynamically-resized.png`：拖拽放大后的浮动窗口
- `04-restored-after-three-cycles.png`：三次最大化/恢复后的窗口
- `05-account-signature-settings.png`：账号级签名设置与预览
- `06-signature-disabled.png`：关闭签名后的无签名回复

目录：

`D:/git/wemail/.worktrees/ai-draft-rework/.tmp/acceptance/account-signature-compose/`

## Agentic Inbox 对比评分

### 功能相似度：90 / 100

| 项目 | 权重 | 得分 | 说明 |
| --- | ---: | ---: | --- |
| 正文内 AI 写作引导 | 20 | 20 | 文案、位置和可交互路径对齐 |
| 点击后聚焦底部输入 | 15 | 15 | 无需二次点击即可输入 |
| 底部 AI 输入与风格/语言 | 15 | 15 | 与竞品相同的信息分层 |
| 收件人、主题、正文层级 | 15 | 13 | 核心顺序一致，WeMail 保留回复浮窗 |
| 签名与品牌尾注 | 15 | 15 | 在竞品体验基础上补齐账号级管理 |
| 窗口与工具操作 | 15 | 12 | WeMail 增加八方向缩放，底部工具略多 |
| 草稿优化和版本能力 | 5 | 5 | 保留现有优化、历史和版本切换能力 |

### UI 美观度：84 / 100

| 项目 | 权重 | 得分 | 说明 |
| --- | ---: | ---: | --- |
| 信息层级 | 20 | 18 | 正文优先，AI 输入固定在底部 |
| 留白和密度 | 20 | 17 | 与 Agentic Inbox 接近，小尺寸回复窗稍紧凑 |
| 圆角、边框和阴影 | 20 | 17 | 统一且克制，浮窗轮廓清晰 |
| 品牌一致性 | 20 | 17 | WeMail 珊瑚色贯穿引导、发送和尾注 |
| 状态反馈与细节 | 20 | 15 | hover/focus/resize 完整；窗口较小时引用区仍需滚动 |

## 已知差异

- Agentic Inbox 参考图以大面积全屏撰写为主；WeMail 回复仍采用覆盖邮件正文的浮动窗口，以保留原邮件上下文。
- WeMail 保留“保存草稿、丢弃、附件、格式化”等现有操作，底部比竞品略密集。
- Midscene 截图/鼠标健康检查通过，但 Codex Server 在执行动作时被 Windows 以 `spawn EPERM` 拒绝；因此最终实际 UI 验收使用 Playwright Electron 驱动完成。该环境问题不影响本功能的 Electron 运行结果。

## 验证命令

```text
npm run typecheck
npm run test:renderer
npm run build:desktop
node .tmp/accept-electron-compose.mjs
```
