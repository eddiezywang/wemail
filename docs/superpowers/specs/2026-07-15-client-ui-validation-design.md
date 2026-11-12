# WeMail 客户端 UI 验证体系设计

## 目标

为 WeMail Windows Electron 客户端建立一套既能验证确定性交互，又能判断最终视觉和产品语义是否符合预期的 UI 验证体系。它必须覆盖 AI 聊天的流式 Markdown、reasoning、工具卡、队列、停止、确认、引用、附件和长内容滚动，并避免把模型驱动测试当成唯一发布门禁。

## 方案选择

采用“Playwright 主门禁 + Midscene 视觉语义层 + 可选 Webwright 探索层”。

- Playwright 负责可重复、可定位、可在 CI 中稳定运行的状态和交互断言。
- Midscene 复用同一 Playwright 页面和测试数据，负责用户肉眼可见的布局、层级、可读性及产品语义断言。
- Webwright 不进入正式构建门禁，仅作为候选版本前的自主探索工具；发现的问题必须转写成 Playwright 或 Midscene 固定用例后才形成回归保障。

不采用“全部 Midscene”方案，因为模型推理的波动、成本和延迟不适合验证精确事件顺序。不采用“Webwright 直接做 CI”方案，因为它的脚本生成和修复过程本身具有非确定性，并引入额外 Python 运行环境。

## 运行架构

所有客户端 UI 验收都针对最新生产 renderer，而不是 React Router 开发服务：

1. 使用 WeMail 桌面构建 workflow 生成 `build/client`。
2. 使用仓库的静态 renderer 服务在固定端口启动该构建，并执行 HTTP 健康检查。
3. Playwright 和 Midscene 连接同一 URL、同一 mock API 和同一 SSE fixture。
4. Electron 专项用例启动真实桌面 main process，验证窗口创建、renderer 加载、无白屏和桌面 bridge。
5. 测试结束后只清理本次 runner 创建的进程和数据目录，禁止误杀用户浏览器或其他 WeMail 实例。

这样可以消除两个已知风险：开发服务在 Windows 下监听地址/SSR 首请求不稳定，以及端口复用导致测试连接到旧构建。

## 测试分层

### L0：组件和状态机

Vitest/Testing Library 验证 reducer、事件去重、Markdown 安全、reasoning 自动收起、队列操作、草稿恢复、确认状态和引用行为。

### L1：Playwright 确定性验收

通过 mock API/SSE 精确验证：

- reasoning、文本、工具事件的顺序和最终状态；
- 流式期间输入不会 mid-run steering，而是形成队列；
- 正常完成后队列按顺序自动执行；
- Stop 后队列暂停，重启后仍需用户确认；
- 会话切换、历史恢复、面板展开收起；
- Markdown 标题、列表、表格、代码块和安全外链；
- 引用跳转、确认操作、错误、重试和 jump-to-latest；
- 本地文件及邮件附件的添加成功、失败、限制和复用；
- Electron 启动日志包含 `loadURL-done` 和 `ready`，且首窗口不是白屏。

这些用例是 PR 和发布的硬门禁。

### L2：Midscene 视觉语义验收

Midscene 使用 `aiAssert` 和少量 `aiQuery` 验证 Playwright 不擅长表达的结果：

- 最终答案呈现为可读 Markdown，而不是原始标记文本；
- 活跃 reasoning 明显可见，完成后收起且仍可查看；
- 工具卡视觉层级低于最终答案，状态容易识别；
- 队列、暂停和确认状态不与已发送消息混淆；
- 长回答没有遮挡、溢出、异常空白或错误滚动；
- 附件、引用和确认卡在窄/宽面板中均保持可读；
- 整体呈现像 WeMail 原生能力，而不是嵌入式网页或调试输出。

Midscene 用例分为两组：

- `smoke`：5～8 条高价值场景，UI PR 必跑；
- `visual-regression`：完整场景，nightly 或候选版本运行。

模型断言失败必须保存截图、轨迹和 HTML 报告。单次视觉断言失败不能用自动重试掩盖；只有确认属于模型波动时才允许人工复跑。

### L3：Webwright 探索式 QA

Webwright 仅用于开放式任务，例如“作为重度邮件用户连续使用聊天和附件功能，寻找不可恢复状态或视觉问题”。运行产物保存为脚本、截图和轨迹。任何有效问题都要转成 L0/L1/L2 固定测试，Webwright 自身不决定发布是否通过。

## 场景与数据

使用可复现 fixture，不依赖真实邮箱或外部模型响应。SSE fixture 至少包含：

- reasoning → tool → Markdown 正常完成；
- 流式期间排入两条 follow-up；
- Stop、应用重启和显式恢复；
- 工具失败、可重试错误和最终失败；
- 邮件引用、附件引用和不可用来源；
- 待确认、已确认、已拒绝、已过期；
- 本地附件成功、损坏、超限和重复添加；
- 超长 Markdown 和用户向上滚动。

动态时间、随机 ID、头像和端口不进入视觉断言，或使用遮罩处理。测试只读取专用临时账户和数据目录。

## 报告与门禁

每次验收输出：

- Playwright HTML report、trace 和失败截图；
- Midscene HTML report、自然语言断言记录和截图；
- Electron startup log 和 renderer health 结果；
- OpenSpec acceptance tracker 中的命令、提交和证据路径。

门禁规则：

- L0/L1 任一失败即失败；
- Midscene smoke 的明确产品问题即失败，模型不确定性需人工判定；
- Webwright 发现 P0/P1 问题时阻止候选版本，但其普通执行成功率不作为门禁指标。

## 实施顺序

1. 抽取生产 renderer 验收 fixture，消除 stale port 和 dev SSR 依赖。
2. 将现有 Midscene 旧布局断言改为当前 WeMail 工作台和 AI 面板。
3. 新增 AI 聊天 Playwright fixture 与确定性场景。
4. 新增 Midscene smoke/visual-regression 场景和报告目录。
5. 新增 Electron 窗口/白屏专项用例。
6. 接入 npm scripts 与 OpenSpec acceptance evidence。
7. 在本地完整运行并修复发现的问题，再将 smoke 纳入 UI PR 门禁。

## 非目标

- 不用 Midscene 替换现有 Playwright 测试。
- 不把 Webwright、Browser Use 或 Stagehand 引入正式应用运行时。
- 不在测试中使用真实邮件凭据、真实用户数据或生产模型密钥。
- 不对动态内容做大面积像素级快照；视觉判断聚焦稳定结构和产品语义。
