# WeMail 整体运行时资源优化实施计划

## 实施约束

- Electron 是唯一桌面运行时，不引入或恢复 Tauri/Rust。
- Mail Core 只保留 DB Writer、IMAP、AI 三个业务 Worker；API Worker 如启用仅是薄隔离层。
- DB Writer 始终是唯一数据库写入者。
- 性能结论使用三次干净启动，每次两个一分钟窗口、每5秒采样。
- 每批改动独立测试、测量、提交；收益未确认前不叠加下一项高风险重构。
- 保留工作区并行修改，逐文件显式暂存并检查缓存区文件列表。

## 阶段一：整体资源归因

1. 扩展 `scripts/measure-mail-core-performance.ps1`，将稳定 Electron 子进程标记为 Main、Mail Core、Renderer、GPU、Network、Crashpad 和其他进程。
2. 原始样本保留 PID、父 PID、命令行、角色、WS、Private、CPU、线程和句柄。
3. 汇总每个角色及全进程 P50/P95/max，并计算线程、句柄增长率。
4. 将默认时长改为60秒，同时允许显式覆盖。
5. 为进程分类和百分位计算增加可在无 Electron 环境运行的测试或纯函数验证脚本。

## 阶段二：Snapshot 查询收敛

1. 在 `InvoiceStatusRepository` 增加按账户和邮件 ID 集合批量读取邮件级状态的接口。
2. 为批量接口增加空集合、多邮件、多附件、跨账户隔离测试。
3. 修改 `CoreSnapshotService.list()`，一次获取页面全部发票状态，`toSummary()` 不再访问数据库。
4. 列表查询使用 limit-plus-one 判断下一页，避免同一请求额外执行 `hasMessages()`。
5. 保持精确 count 契约；如性能仍不满足，再增加带 mail-generation 失效的短期 count cache。
6. 增加测试证明50封列表不会触发逐邮件状态查询，并保留 Snapshot 预算指标。

## 阶段三：SQLite 角色预算

1. 扩展 `Database.ts` 的打开选项，声明 `writer`、`snapshot`、`imap`、`intelligence` 等连接角色。
2. 为只读角色配置 `query_only`、`busy_timeout`、负数 KiB `cache_size` 和实测选择的 `mmap_size`。
3. DB Writer 保留 WAL/foreign key/迁移所有权，其他运行时不执行迁移。
4. 检查 Mail Core 主连接、IMAP Worker、AI Worker和临时 reload 连接的创建/关闭路径。
5. AI恢复、Maintenance 和目录修复扫描增加条数及总正文字节上限。
6. 增加 pragma、只读写保护、连接关闭和有界批次测试。

## 阶段四：AI Worker 轻量装配

1. 新建 `MailCoreIntelligenceComposition.ts`，只装配 durable queue、LLM runtime、必要仓库和 processor factory。
2. 将 processor 注册改为按 job kind 动态导入，启动时不加载未使用处理器。
3. `intelligence-worker-entry.ts` 不再调用通用完整 `composeIntelligence()`。
4. 启动恢复限制批次任务数、邮件数和正文总字节；每批让出事件循环。
5. 熔断 open 时不读取正文或构造模型上下文；half-open 只加载探测任务。
6. 测试模块边界、懒加载、任务恢复、熔断、关闭清理和 Worker health。

## 阶段五：Electron Main 薄控制面

1. 枚举 Local API 路由，将其分类为 desktop-local、Mail Core query、Mail Core command 和 degraded-unavailable。
2. 新建 typed RPC contracts 和 gateway adapters；业务路由转发给 Mail Core owner。
3. 提取 `composeDesktopControlPlane()`，只保留窗口、通知、设置桥、账户桥和 Supervisor 所需组件。
4. `startLocalApi()` 默认不再调用完整 `composeApp()`。
5. MCP listener 通过 RPC 执行业务操作，不在 Main 中导入业务仓库图。
6. 临时保留 `WEMAIL_LEGACY_FULL_LOCAL_API=1` 回滚开关；最终验收通过后决定删除。
7. 测试路由映射、RPC错误、只读降级、超时和禁止静默回退完整 composition。

## 阶段六：后台 IMAP Provider 懒加载

1. 将 background provider 包装为按需工厂，账户启动只创建 foreground provider。
2. 正文、附件或批量传输首次入队时创建 background provider。
3. 队列清空并达到 idle timeout 后关闭后台 provider 和 socket。
4. 前后台认证失败继续汇聚到同一 credential-required 事件。
5. 测试懒创建、复用、空闲关闭、重建、认证失败和 foreground 隔离。

## 阶段七：Renderer/GPU 定向优化

1. 仅在后端优化后重新采集 Trace。
2. 定位触发 mousemove 强制布局、邮件列表布局和正文 frame 重建的具体组件。
3. 实施列表虚拟化、不可见区域延迟渲染、事件合并和 ContextBridge 载荷收敛。
4. 对每项 UI 修改记录 Long Task、Layout、Raster、Renderer/GPU Private 的 A/B。
5. 不默认禁用 GPU。

## 阶段八：最终验收

1. 执行 typecheck、server/renderer 测试和所有新增聚焦测试。
2. 使用 `wemail-desktop-build` 完成 `npm run build:desktop`、可见窗口和启动日志验收。
3. 故障注入验证 IMAP、AI、DB Writer、Durable Queue、Outbox、认证对话框和 API timeout。
4. 三次干净启动分别采集一分钟 idle 和一分钟 interaction。
5. 生成整体进程、Mail Core Worker、邮件延迟、故障结果及 Trace 报告。
6. 硬门槛：全进程 Private P95 ≤600 MiB、Mail Core P95 ≤250 MiB、CPU平均 ≤3%、Snapshot P95 ≤20ms、缓存邮件元数据 P95 ≤100ms。
7. 每批显式提交；最终同步 `main` 并推送。

## 预计提交顺序

1. `test: attribute wemail desktop process resources`
2. `perf: batch mail snapshot metadata queries`
3. `perf: budget mail core sqlite readers`
4. `refactor: slim mail core intelligence composition`
5. `refactor: make desktop api a thin mail core gateway`
6. `perf: lazily activate background mail transfer`
7. `perf: reduce desktop layout and raster stalls`（仅在需要时）
8. `test: verify wemail runtime resource targets`
