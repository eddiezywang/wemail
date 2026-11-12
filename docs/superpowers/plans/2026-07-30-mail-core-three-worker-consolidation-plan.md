# Mail Core 三 Worker 收敛实施计划

## 实施原则

- 只修改 Electron Mail Core 运行时，不触碰现有 MCP、SMTP 和数据库迁移中的并行改动。
- 每个阶段先补测试，再切换运行入口；保留环境变量回滚开关直到真实桌面验收通过。
- DB Writer 始终是唯一写入者。主运行时新增的服务只能打开只读数据库。
- IMAP、AI 和 DB Writer 继续保持 Worker 隔离；API Worker 不计入三个业务 Worker，但不在本次改造中扩大职责。

## 阶段一：合并读取 Worker

1. 新建 `server/wemail/mail-core/CoreSnapshotService.ts`：
   - 接管 `MailCoreSnapshotStore` 的单封邮件快照；
   - 接管 `read-worker-entry.ts` 的列表、文件夹和分类查询；
   - 复用一个长期只读数据库连接；
   - 提供同步查询方法和 `health()`，记录请求数、最近耗时和慢查询数。
2. 新建 `CoreSnapshotService.test.ts`，覆盖：
   - 列表与游标；
   - Draft 本地计数；
   - 分类、发票投影和正文 overlay；
   - 关闭连接后不再接受请求。
3. 修改 `electron/mail-core/entry.ts`：
   - 默认直接创建 `CoreSnapshotService`；
   - 不再创建 Query Reader 和 Aggregate Reader；
   - RPC 直接调用主运行时服务；
   - `WEMAIL_MAIL_CORE_LEGACY_READ_WORKERS=1` 可临时回滚旧拓扑。
4. 更新 `CoreHealthResultSchema`：加入主运行时 Snapshot 指标，并允许旧 `readers` 字段在回滚模式下存在。

## 阶段二：合并 Background Worker

1. 新建 `server/wemail/mail-core/CoreMaintenanceCoordinator.ts`：
   - 复用 Durable Queue 的四类任务；
   - 每次只 claim 一个任务；
   - 搜索历史每批最多 25 封；
   - 搜索 chunk 按邮件执行，并在批次间通过 `setImmediate` 让出事件循环；
   - Body Backfill 和 Retention 仍通过 DB Writer 提交；
   - 前台活动或 Governor 暂停时停止 claim 新任务。
2. 将日志保留逻辑提取为独立纯函数模块，便于测试且避免 Coordinator 文件膨胀。
3. 新建 Coordinator 测试，覆盖：
   - 四类任务结果；
   - 失败重试和 lease 释放；
   - 前台暂停、恢复和停止；
   - 每个批次主动让出事件循环。
4. 修改 `electron/mail-core/entry.ts`：
   - 默认创建 `CoreMaintenanceCoordinator`；
   - 不再启动 Background Worker；
   - `WEMAIL_MAIL_CORE_LEGACY_BACKGROUND_WORKER=1` 可临时回滚；
   - 正文完成和元数据提交继续 enqueue 搜索任务。

## 阶段三：Resource Governor 迟滞修复

1. 扩展 `ResourceGovernorThresholds`：
   - 增加 `firstSyncGrowthResumeBudgetBytes`；
   - 默认 cooldown 从 2 秒调整到 15 秒；
   - 高水位和低水位使用对称条件。
2. 修复恢复判断：绝对 RSS、相对基线增长、事件循环和 CPU 四个低水位必须全部满足。
3. 增加最小状态驻留，避免相邻采样重复 pause/resume。
4. 补充测试复现 440MB 区间振荡，并验证修复后保持暂停直到相对增长回落。
5. Mail Core 主运行时创建 Governor；邮件 RPC 调用 `markForegroundActivity()`，Coordinator 使用 `waitForAdmission("background")`。

## 阶段四：逐 Worker 指标

1. 建立统一 `WorkerRuntimeMetrics` 协议：
   - `rssBytes`、`heapUsedBytes`、`heapTotalBytes`、`externalBytes`、`arrayBuffersBytes`；
   - `threadId`、`queueDepth`、`activeJobKind`、`activeJobAgeMs`；
   - `restartCount`、`restartBackoffMs` 和最后心跳。
2. DB Writer、IMAP、AI 每 5 秒随心跳上报内存；Runtime 的 `health()` 汇总队列、活动任务和重启信息。
3. 主运行时 health 加入自身内存、Snapshot、Maintenance 和 Governor 状态。
4. 更新协议 schema 与 Runtime 单元测试，保证缺失可选指标时仍兼容旧 Worker。

## 阶段五：AI 失败节流

1. 先复用现有 Intelligence Queue 的失败状态，增加 Runtime 级 closed/open/half-open 熔断状态。
2. 连续可重试网络失败达到阈值后停止 enqueue 唤醒和高频轮询；到期只允许一个半开探测。
3. 成功后闭合；非网络/不可重试错误不计入网络熔断。
4. health 暴露熔断状态、连续失败次数和下次探测时间。
5. 补充 closed/open/half-open 及重启后队列不丢失测试。

## 阶段六：验证与收尾

1. 静态验证：
   - `npm run typecheck:server`
   - `npm run typecheck:desktop`
   - `npm run typecheck`
2. 自动化测试：
   - 新增 Mail Core、Governor 和协议测试；
   - `npm run test:server`
   - `npm run test:renderer`
3. Electron 验收：
   - `npm run build:desktop`
   - 使用快速桌面流程启动真实 Electron；
   - 验证窗口、Mail Core ready、邮件缓存/未缓存打开、IMAP 认证弹窗和 Worker 故障恢复。
4. 性能 A/B：
   - 记录启动后 30 分钟 Working Set、Private Bytes、CPU、线程和句柄；
   - 连续打开缓存与未缓存邮件，输出 RPC、元数据首屏、正文完成 P50/P95/max；
   - 输出 `workspace/reports` 下 JSON 和可浏览报告；
   - 对比原基线 421MB WS / 473MB Private。
5. 只有满足规格完成条件才删除两个 legacy 回滚开关和旧 Reader/Background 文件；若未达标，保留开关并在报告中列明瓶颈。

## 提交顺序

1. `refactor: merge mail core read workers`
2. `refactor: move mail maintenance into core runtime`
3. `fix: stabilize mail core resource governor`
4. `feat: report mail core worker metrics`
5. `fix: circuit break repeated intelligence failures`
6. `test: verify mail core three worker performance`

