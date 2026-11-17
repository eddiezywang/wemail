## Why

邮件同步是 WeMail 的核心数据来源。历史用户反馈包括经常收不到新邮件、第一次重启无效、再次重启才恢复。2026-11-04 对当前源码的静态审查发现：账户线程重启未重新建立同步与监听，启动同步任务重试耗尽后缺少长期恢复入口，IDLE 与轮询互斥，增量结果截取最新 5,000 个 UID，正文调度与资源暂停可阻塞元数据同步，其他文件夹反复按 INBOX 日期扫描。

审查基线已有游标 ACK、分批持久化、心跳和账户配置重试，能够修复部分故障，但不能保证持续收信、增量完整性或延迟有界。本提案定义修复目标；工作区中的后续实现改动尚未验证，不能据此认定问题已解决。审查未复现历史事故，不能将上述路径认定为该事故的已证实根因。

## What Changes

- 为账户启动、线程重启、网络恢复和凭据更新建立统一的收信恢复入口，使用数据库已提交的文件夹游标。
- 使账户恢复调度独立于单个任务的重试预算；凭据错误等待用户处理，临时网络错误持续退避恢复。
- 同时保留 IDLE 和每 60 秒的补偿检查；合并触发，并保留运行期间产生的再次检查意图。
- 将增量补拉改为 UID 升序分页，邮件与页游标原子提交，取消静默截断和跨文件夹日期游标。
- 在有界操作边界优先处理实时元数据及手动刷新，防止正文积压和后台限流无限阻塞核心同步。
- 增加同步进度超时、健康状态和分阶段延迟诊断，保留静默后台恢复与局部刷新反馈。
- 为旧版本可能已跳过的区间提供有检查点的有限范围修复，明确修复覆盖范围，避免误报全量完整。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mail-sync`: 持续恢复、推送补偿、无遗漏分页、独立文件夹游标及旧数据修复。
- `mail-runtime-scheduler`: 元数据优先、触发合并、恢复退避、资源准入和超时边界。
- `mail-runtime-observability`: 进度健康、真实刷新结果和延迟归因。

## Impact

- Runtime: `electron/mail-core/entry.ts`、`account-worker-entry.ts`、`server/wemail/mail-core/MailCoreAccountRuntime.ts`、账户 Worker 协议和测试。
- Provider: `server/wemail/mail/ImapSmtpMailProvider.ts`、`MailProvider.ts` 及其调用者与测试。
- Persistence: `MailDatabaseWriter.ts`、`MailDatabaseQueryRepository.ts`、producer、数据库协议与相关迁移/事务测试；优先复用现有文件夹同步状态。
- Presentation: 现有刷新 API、共享健康契约、`app/hooks/useMailEvents.ts` 及刷新调用处；按需要更新测试和 fixture。
- Performance: 现有 ResourceGovernor 的工作负载准入及调度测试。
- 无新增依赖、独立服务或额外常驻 IMAP 连接；保留单 Writer、Electron 和 ImapFlow。

## Related Changes

- `streamline-realtime-mail-refresh`: 延续单一刷新入口、推送连接职责及通知去重；补全持续恢复和防丢触发。
- `optimize-initial-sync-performance`: 延续有界分页与资源约束，明确核心增量不随历史任务无限暂停。
- `replace-mail-runtime-with-single-local-database`: 延续单 Writer、事件驱动队列和可恢复检查点；补偿定时器产生远端检查意图，不轮询领取业务队列。
- `fix-imap-background-session-ownership`: 延续单连接的串行所有权和页间让出；本次不改变连接数量或部署配置。
- `silence-background-mail-sync-status`: 延续静默后台恢复，不恢复全局同步进度条。

已有方案的正文先于实时元数据调度、仅依赖推送、或允许截断后推进游标的表述若与本 change 冲突，以本 change 的对应收信要求为准；其他职责保持各原方案约定。
