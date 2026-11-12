# Verification record — 2026-11-05

状态：实施与验收进行中，不能标记 change 完成。用户已授权 `npm run verify:changed`、`npm run build:desktop` 和隔离数据目录运行验收；未授权打包、安装或停止现有客户端，禁止重编译 SQLite binding。

## 2026-11-05 隔离桌面验收

### 开发版启动故障恢复（使用真实数据目录）

用户报告诊断号 `startup-mw35km6t-9pavxs`，并明确授权全部必要修复操作。对应启动日志显示 API 已启动，加载 `http://127.0.0.1:5173/` 时发生 `ERR_CONNECTION_REFUSED`；检查时前端端口无监听、旧客户端仍运行。此故障与隔离测试中等待 API 的超时不同，不能混为同一根因。

执行 `npm run desktop:restart`，由仓库脚本请求旧开发版正常退出，并以 detached 方式同时托管前端和客户端。新主进程 PID 11540、前端 PID 23120、API 端口 58633；日志于 15:00:05（北京时间）记录 `loadURL-done` 和 `ready`，之后真实 renderer 的 folders/categories/list 请求成功，前端记录收到 50 封收件箱邮件。未新增源码修补来掩盖开发服务缺失，未打包安装。原生窗口自动化 pipe 不可用，未取得桌面画面证据；前端服务此前为何退出仍无历史日志可证。

- `npm run build:desktop` 成功：界面边界检查、renderer 构建及 bundle budget、Electron 生产 TypeScript 编译通过。测试文件已有的类型检查阻塞不影响本次生产构建，但验证门禁仍未通过。
- 使用 Playwright CLI 直接运行 `tests/e2e/08-mail-receipt-recovery.spec.ts`，绕开会重编译原生 binding 的 E2E npm 包装脚本；每次实例使用独立 `E:\temp\wemail-e2e-data-*`，不访问实际邮箱数据目录。
- 首轮启动在等待 API 端口 30 秒后失败，DB 与 Mail Core 已 ready，具体阻塞原因尚未确定。增加隔离实例 stdout/stderr 留存后，下轮约 5 秒完成启动，未调整启动超时，不能认定首次启动问题已经解决。
- 修正新增测试在空邮箱时遗漏创建 mock-inbox 目录的问题后，隔离交互测试通过（19.0 秒）：5 次逐封注入、每次两个并发刷新版本完成、各邮件列表恰一次、用户点击刷新完成及按钮恢复。
- provider 为 FileInjectedMailProvider，这些结果证明本地 IPC/Writer/回执/列表交互，不证明真实 IMAP 网络性能、实际 IDLE 或大邮箱下 p95 达标。真实邮箱凭据不进入测试及报告。
- 扩展同一用例，关闭自己的隔离实例后复用数据目录重启，再注入独立 Message-ID 的第 6 封邮件，核对旧 5 封保留及新邮件可见：通过（41.9 秒）。首次扩展夹具错误复用 Message-ID，修正后不再把按身份合并误当作遗漏。
- 扩展重跑过程中再次出现启动端口等待超时，不能归因于单次机器抖动。已补充 `local-api-integrity-begin/done` 和 `local-api-composition-done` 脱敏阶段日志，主进程增量编译通过；问题未定位前保持验收未完成。
- 加入阶段日志后再次执行同一用例并 `--repeat-each=3`：3/3 通过，总耗时 1.9 分钟，单轮 34.5/33.8/37.1 秒；共验证 6 次隔离启动。三轮各 5 次本地刷新至可见采样的中位数分别为 217.9/224.9/189.0 ms，最大值为 871.5/281.5/231.5 ms。只有 15 次模拟样本，不推导真实邮箱 p95 或容量结论，也不撤销之前的启动失败记录。
- 本次变更的 `git diff --check` 通过；未停止既有客户端、修改生产数据目录、重编译 native binding、打包或安装。

## 已通过的针对性测试

| 范围 | 数量 | 证据覆盖 |
| --- | --- | --- |
| `MailCoreAccountRuntime.test.ts`、`retryAccountConfiguration.test.ts` | 28 | 空闲 Worker 退出、读取最新检查点、正文与资源暂停下的元数据优先、补偿检查、休眠后意图合并、stop 后无计时回调、页间合并、旧线程完成、心跳与进度看门狗、限流、检查点读取失败、任务六次耗尽后的恢复、配置持续重试及旧凭据失效 |
| `ImapSmtpMailProvider.test.ts`、`BackgroundTransferMailProvider.test.ts`、`MailProviderFailure.test.ts` | 53 | 6,000 封有界补拉、缺项与已删除 FETCH、实际 socket 超时回收、INBOX 重新检查及目录公平性、提交状态续跑、历史修复、UIDVALIDITY 替换、封装传递恢复状态及 iterator 清理 |
| `MailDatabaseWriter.sync.test.ts` | 4 | 邮件/检查点事务回滚、旧租约及旧检查点拒绝、ACK 丢失后的安全重放、正文任务与页一并入队、恢复实时游标下方的缺口、修复不回退/冒进实时高水位、输入页边界校验 |
| `mailRefresh.test.ts`、`mailReceiptTrace.test.ts`、`mailBodyCache.test.ts` | 6 | 入队与完成区分、失败/旧 runtime/认证失效、观察超时、旧响应兼容、真实可见 ID 与新查询数据的诊断关联、缺少正文缓存标记不误判 |
| `MailCoreRpcHost.test.ts` | 6 | 现有 RPC 路由及认证错误穿透到刷新调用者 |
| `McpSyncProjection.test.ts` | 3 | 复用任务 ID 时按请求版本判断完成，忽略请求前的缓存快照，运行时替换、提交失败及账户不可用显式失败 |
| `mail-core-supervisor.test.ts` | 3 | 健康快照校验及账户隔离，凭据更新、账户重载与进程断开清除旧快照 |
| `electron/mail-core/account-worker-entry.test.ts` | 2 | 取消远端等待和提交 ACK 等待，确认旧 iterator 关闭后释放槽，保持 SMTP provider 和发送结果，忽略旧 ACK |
| `electron/mail-core/entry.test.ts` | 6 | 账户切换先停旧 Worker，重叠凭据仅启动最新世代，旧 DB 读取结果失效，DB 断开停止收信，关闭不复活 Worker，历史/重放通知抑制 |
| `notification-coordinator.test.ts`、`notification-ledger.test.ts` | 12 | 既有通知分类、聚合、稳定键去重、失败可重试与持久化账本回归 |
| `useMailEvents.test.tsx` 的新增元数据插入用例 | 1 | 无正文或文件夹事件时，新邮件元数据插入直接刷新列表、文件夹和分类计数；同文件其余 10 项未在此次定向命令中执行 |

以上共 124 项。SQLite 用例通过 `ELECTRON_RUN_AS_NODE=1` 运行 `node_modules/electron/dist/WeMailDesktop.exe --import tsx --test --test-force-exit --test-concurrency=1 server/wemail/database/MailDatabaseWriter.sync.test.ts`；只使用内存数据库，没有修改 ABI binding 或业务数据。

普通服务端用例使用 `node --import tsx --test --test-force-exit`；本轮完整重跑 Provider、后台分页封装及故障分类三个测试文件，53 项全部通过。前端纯逻辑用例使用 `npm run test:renderer:node -- app/lib/mailRefresh.test.ts app/lib/mailReceiptTrace.test.ts shared/wemail/mailBodyCache.test.ts`。

## 未通过或未完成的检查

- `npm run verify:changed` 识别出 174 个工作区改动，在 Windows 上启动第一个子命令时退出，没有完成 profile。随后直接执行了相关类型检查和测试；未修改验证脚本。
- 服务端及桌面类型检查报告 `server/wemail/database/MailDatabaseWriter.ai.test.ts:81` 的 `number`/`string` 类型错误。最后一次桌面类型检查未报告本次同步代码的类型错误，但全局命令仍失败。
- 渲染层类型检查报告 `AgentPanel.tsx`、`AdvancedSection.tsx`、`McpSection.tsx`、`ModelSection.tsx`、`AppTitlebar.tsx` 的类型错误；未修改这些并行工作来通过检查。
- 首轮 Provider/调度测试的分页封装清理问题已修复。两个旧 Provider 用例也已按现有调用契约修正：等待异步账户更新完成；先断言超大后台正文被拒绝，再显式 onDemand 验证仅取正文部件。完整 Provider 分组重跑 53 项全部通过，没有放宽正文资源限制。
- 广泛的 `test:renderer:related` 已报告 onboarding、workspace、编辑器、workbench 等多处失败；相关测试长时间无输出后，按用户明确授权仅停止本轮 Vitest 6136 及其 worker 49248；该次执行未得到完整测试汇总，不能记为通过。其他开发和桌面进程未停止。

## 尚缺的验收证据

- 已补入口消息级集成测试及受控 Writer 超时/晚到结果测试；真实休眠恢复、Writer 超时后的跨进程故障注入仍缺。
- SMTP 发送期间的独立元数据取消已实现，并有 Provider、Worker 消息处理及账户 runtime 三层测试。真实跨进程并发发送与收信故障恢复仍待运行时验证。
- Windows 真邮箱的逐封集合比对、持续收信、首批列表可见 p50/p95/max 和资源采样；当前单元用例耗时不证明真实邮箱 p95 ≤ 5 秒。
- 隔离数据目录的完整故障矩阵和安装版本验证。构建及模拟收信/重启交互已通过，启动超时仍有失败记录；当前安装产品没有因源码改动而升级。

## 诊断关联

本轮新增测试先复现并修复了三个边界：新账户配置阻塞期间旧 Worker 未停止、进入进度恢复后晚到 Writer 结果仍确认完成、停止后晚到租约占用至过期。历史元数据现在与后台正文交替领取，实时检查始终先行，避免旧缺口修复被正文积压饿死。修复覆盖日期及完成标记进入既有提交 debug 日志。

新增 Provider → Writer 内存 SQLite 测试完整写入 6,000 封稀疏 UID、乱序日期邮件，第三页提交后模拟 ACK 丢失并替换 provider/租约，从已提交检查点续跑，逐个核对远端 UID 与本地实例集合，核对正文任务恰为 6,000 项，重复检查不发布新增消息事件，最大 FETCH 50 封、最大同时 session 1。该次 fixture 执行约 48.8 秒；这是当前共享机器下的测试耗时，不能作为真实邮箱延迟或吞吐承诺。

开启现有 debug 日志后，用 `mail.metadata.requested` 的版本和触发时间、`mail.metadata.dispatched` 的 job/owner/generation、`account-worker-metadata-committed` 的 provider/commit 耗时及 commitVersion 串联后台。Writer 请求沿用 owner traceId。渲染端 `[mail-receipt]` 用同一 commitVersion 记录事件送达与视口邮件在新数据渲染后的帧边界；记录有界，不输出邮件 ID、主题、正文或凭据。此关联已补代码和纯逻辑测试，真实端到端采样仍待运行时验收。
