# Mail Core 三 Worker 收敛与内存优化设计

## 背景

当前 Electron Mail Core Utility Process 在真实邮箱环境中包含 DB Writer、两个 Read Worker、Account Worker、Background Worker、Intelligence Worker 以及主运行时 Snapshot Store。一次 37.8 分钟采样显示：

- 稳定态 Working Set 约 421MB；
- 稳定态 Private Bytes 约 473MB；
- 峰值 Working Set 约 506MB；
- 峰值 Private Bytes 约 534MB；
- 32 个线程、719 个句柄在短期采样中保持稳定；
- 30 秒内 Private Bytes 仅增长约 1.1MB，暂未发现短周期线性泄漏。

邮件本地快照 RPC 的 30 次样本为 P50 2ms、P95 4ms、最大 18ms，说明本地读取吞吐并不需要两个独立 Read Worker。日志还显示 Intelligence 队列长期保持任务，并在 LLM 请求 EOF 时继续轮询；Resource Governor 会在相同内存区间反复暂停和恢复。

本设计优先降低 Mail Core 常驻内存，同时建立清晰、可测试的模块边界。核心能力必须保持常驻，不采用大范围延迟启动。允许在明确功能首次使用时产生少量初始化成本，但邮件读取、IMAP 同步和数据库写入必须始终可用。

## 目标

1. 将 Mail Core 收敛为三个隔离 Worker：DB Writer、IMAP、AI。
2. 将查询、聚合、搜索索引协调和维护任务收回 Mail Core 主运行时。
3. 保持数据库单写者、IMAP 故障隔离和 AI 故障隔离。
4. Mail Core 连续运行 30 分钟时，Working Set P95 不超过 250MB。
5. Private Bytes 峰值不超过 320MB。
6. 本地邮件快照 P95 不超过 20ms。
7. 点击邮件到元数据首屏 P95 不超过 100ms。
8. Mail Core 空闲 CPU 平均不超过 3%。

## 非目标

- 不移除 IMAP、AI 或 DB Writer 的进程内隔离。
- 不把 LLM、IMAP 网络请求或 MIME 解析放入 Mail Core 主事件循环。
- 不在本次改造中替换 SQLite、IMAPFlow 或现有智能任务实现。
- 不以牺牲持久化队列、崩溃恢复或邮件首屏延迟换取内存数字。
- 不恢复或引入 Tauri/Rust 桌面运行时。

## 目标架构

### Mail Core 主运行时

主运行时承载低延迟、本地、可分片的协调能力：

- `CoreSnapshotService`：邮件详情、列表、文件夹和分类的只读查询；
- `CoreMaintenanceCoordinator`：搜索索引、历史扫描、正文保留策略和日志保留任务的时间片调度；
- `ResourceGovernor`：统一观察 Mail Core 总体前台活动、后台队列和资源状态；
- RPC Host、Renderer 连接、端点恢复和 Worker 生命周期管理。

主运行时不得执行以下工作：

- IMAP/SMTP 网络访问；
- MIME 正文下载与重解析；
- LLM 请求和智能编排；
- SQLite 写事务；
- 没有时间预算的同步长循环。

### DB Writer Worker

DB Writer 是唯一写入口，继续负责：

- 邮件元数据和正文写入；
- Durable Queue 与 Outbox 的 claim、complete、fail；
- 远程操作结果提交；
- 搜索索引、智能结果和维护状态持久化；
- 写事务串行化和 WAL 一致性。

其他运行时通过 MessagePort 客户端访问 DB Writer，不直接打开可写数据库。

### IMAP Worker

现有 Account Worker 演进为明确的 IMAP Worker，负责：

- 实时 IMAP 连接、轮询或 IDLE；
- 元数据同步；
- 正文 FETCH 和 MIME 解析；
- 移动、删除、标记等远程操作；
- 明确认证失败熔断。

IMAP Worker 崩溃、网络失败或认证失败时，本地缓存邮件必须仍可读取。

### AI Worker

AI Worker 保留完整隔离，负责：

- LLM Runtime；
- 摘要、标签、待办、链接和草稿任务；
- Intelligence Queue 和 Workspace；
- AI 结果写入请求。

连续网络失败必须进入熔断状态。熔断期间保留持久化任务，但停止重复请求和高频轮询；恢复通过定时探测或用户手动操作触发。

## 移除的独立 Worker

### Query Reader 与 Aggregate Reader

两个 Read Worker 合并为主运行时的 `CoreSnapshotService`。其依据是当前本地 RPC P95 仅为 4ms，单一查询服务可以满足负载。

`CoreSnapshotService` 使用一个长期只读连接，统一提供：

- 邮件快照；
- 邮件列表；
- 文件夹和分类聚合；
- 发票与智能结果的只读投影。

所有查询必须保持纯只读，并设置超时和查询预算。

### Background Worker

Background Worker 的独立 isolate 被移除。原能力迁移到 `CoreMaintenanceCoordinator`：

- 每个任务以小批次执行；
- 每批有明确的行数或时间预算；
- 批次间主动让出事件循环；
- Renderer 前台活动时暂停；
- 结果只能通过 DB Writer 写入；
- Durable Queue 继续作为任务真相来源。

高成本文本切分必须可中断。若实测单批计算仍造成事件循环 P95 超标，应将纯 CPU 分词改为共享 Worker Pool，而不是恢复完整 Background Runtime。

## 数据流

### 点击邮件

1. Renderer 请求邮件快照。
2. `CoreSnapshotService` 读取元数据和缓存正文并立即返回。
3. 若正文缺失，主运行时通过 DB Writer 持久化 `mail.body.ensure`。
4. IMAP Worker claim 任务并执行 FETCH/MIME 解析。
5. DB Writer 写入正文并发布邮件变更事件。
6. Renderer 增量刷新正文，不重新加载整个页面。

### 元数据同步

1. IMAP Worker 读取同步游标并访问服务器。
2. IMAP Worker 将结果发送给 DB Writer。
3. DB Writer 提交元数据和游标。
4. 主运行时更新 Snapshot 投影，并触发索引和智能任务。

### 搜索索引与维护

1. `CoreMaintenanceCoordinator` 从 Durable Queue claim 小批任务。
2. 通过 Snapshot Service 读取必要数据。
3. 执行受预算控制的分词、历史扫描或保留计算。
4. 通过 DB Writer 提交结果。
5. 前台活动、资源超限或时间预算耗尽时保存进度并让出事件循环。

### 智能任务

1. AI Worker 从持久化智能队列读取任务。
2. 通过只读代理获取邮件和设置。
3. 调用 LLM 并产生结果。
4. 通过 DB Writer 写入结果。
5. 连续失败进入熔断，不影响邮件读取和 IMAP。

## 故障处理

### IMAP Worker

- 网络失败：指数退避，保留本地读取；
- 认证失败：进入 `credential-required`，停止所有 IMAP 工作并弹出阻塞式改密对话框；
- Worker 崩溃：Supervisor 重启 Worker，释放或延迟当前 lease；
- 远程副作用：使用 Outbox 和幂等键避免重复。

### AI Worker

- Worker 崩溃：指数退避重启；
- LLM 连续失败：达到阈值后进入熔断，停止请求；
- 熔断恢复：半开探测成功后恢复队列；
- 任务失败不阻塞邮件首屏、IMAP 或搜索。

### DB Writer Worker

- DB Writer 不可用时，Mail Core 进入只读降级；
- 禁止发起新的远程副作用，因为无法保证 Outbox 提交；
- 本地快照可继续读取；
- Writer 恢复后重新验证 schema、queue lease 和 WAL 状态。

### 主运行时

- 单 Worker 失败不得导致 Utility Process 整体退出；
- Renderer 必须看到明确的降级或恢复状态，不得无限骨架屏；
- Crashpad 和 Supervisor 继续记录退出码、最后心跳与端点代次。

## Resource Governor 修正

当前高水位判断同时包含绝对水位和相对基线增长，但恢复判断只检查绝对低水位，导致在“低于 500MB、但仍超过基线增长预算”时反复暂停和恢复。

新的迟滞规则为：

- 暂停条件：任一高水位成立；
- 恢复条件：所有对应低水位同时成立；
- 对基线增长增加独立的恢复预算；
- 冷却时间至少 15 秒；
- 状态转换做去抖和最小驻留时间；
- 前台邮件操作拥有高于后台维护和 AI 的优先级。

Governor 只控制可延迟的后台任务，不暂停正文 FETCH、用户发起的远程操作或 DB Writer 提交。

## 可观测性

每个 Worker 每 5 秒上报：

- `threadId`、状态和最后心跳；
- `rss`、`heapUsed`、`heapTotal`、`external`、`arrayBuffers`；
- `queueDepth`、`activeJobKind` 和 `activeJobAgeMs`；
- 重启次数与当前退避；
- 数据库连接类型。

Mail Core 主运行时汇总：

- Utility Process OS Working Set、Private Bytes、CPU、线程和句柄；
- 各 Worker 的内存分项；
- 前台邮件打开阶段耗时；
- Governor 状态转换；
- AI 熔断状态。

开发者性能报告应输出 JSON，并可与基线报告自动比较。

## 迁移阶段

### 阶段一：观测基线

- 为所有 Worker 增加统一内存指标；
- 建立 30 分钟空闲、邮件连续打开、同步与 AI 任务四类基线；
- 不改变现有运行时拓扑。

### 阶段二：Reader 合并

- 实现 `CoreSnapshotService`；
- 将 Query/Aggregate RPC 切换至主运行时；
- 删除两个 Read Worker；
- 验证查询延迟、事件循环和内存变化。

### 阶段三：Background 合并

- 实现 `CoreMaintenanceCoordinator`；
- 将索引、历史扫描、正文维护和 Retention 改为时间片任务；
- 删除 Background Worker；
- 验证前台活动下的任务暂停和恢复。

### 阶段四：治理与熔断

- 修复 Resource Governor 迟滞；
- 增加 AI 网络失败熔断；
- 完成三 Worker 拓扑和最终 30 分钟验收。

每个阶段独立提交并保留显式开关，下一阶段只有在前一阶段功能与性能门槛通过后才能启用。

## 测试策略

### 单元测试

- Snapshot Service 查询和超时；
- Maintenance Coordinator 时间预算、让出事件循环和断点恢复；
- Resource Governor 高低水位迟滞；
- AI 熔断 closed/open/half-open 状态；
- Worker 内存指标解析与聚合。

### 集成测试

- DB Writer 单写者不变量；
- Reader 合并前后结果一致；
- Background Worker 迁移前后索引结果一致；
- Worker 崩溃后 lease 恢复且不重复远程副作用；
- IMAP 认证失败仍进入 `credential-required`；
- AI 故障不影响邮件读取。

### 桌面验收

- Electron 窗口可见，启动日志包含 `loadURL-done` 和 `ready`；
- 连续点击缓存与未缓存邮件，记录首屏与正文完成时间；
- 分别注入 IMAP、AI 和 DB Writer 崩溃；
- 运行 30 分钟稳定态采样并生成 A/B 报告；
- 检查 Crashpad、端点恢复和凭据弹窗。

## 完成条件

仅当以下条件全部成立，三 Worker 收敛才视为完成：

1. 运行时拓扑只保留 DB Writer、IMAP、AI 三个业务 Worker；
2. 两个 Read Worker 和 Background Worker 不再创建；
3. 30 分钟 Working Set P95 ≤ 250MB；
4. Private Bytes 峰值 ≤ 320MB；
5. 本地快照 P95 ≤ 20ms；
6. 点击邮件到元数据首屏 P95 ≤ 100ms；
7. 空闲 CPU 平均 ≤ 3%；
8. 三类 Worker 崩溃和认证失败测试通过；
9. Durable Queue、Outbox 和 DB Writer 单写者不变量通过；
10. 类型检查、相关单元测试、集成测试和真实 Electron 验收全部通过。

