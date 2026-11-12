# IMAP 实时收件可靠性实施计划

> 设计依据：`docs/superpowers/specs/2026-07-19-imap-realtime-receive-reliability-design.md`

## 目标

在不引入 Redis、常驻 sidecar 或新的邮件同步框架的前提下，基于 ImapFlow 的自动 IDLE 能力，建立一个薄的连接监督器，使收件具备以下生产行为：

- 支持 IDLE 的服务器，正常情况下新邮件在 10 秒内进入本地。
- 不支持 IDLE 的服务器，最多 60 秒完成一次增量对账。
- 连接建立和重建后立即增量对账，不遗漏离线期间邮件。
- 断线后按 1、2、5、10、30、60 秒退避重连，成功后重置。
- 凭证失效时停止无意义重试，等待账号生命周期重建。
- 高频增量检查不做全量 flag repair；5 分钟安全对账和手动同步保留修复。
- `/sync-status` 暴露监听模式、能力、重连次数和最近成功/错误时间。

## 实施约束

- 沿用 ImapFlow，不自行实现 IMAP 状态机。
- 不调用 `client.idle()`；由 ImapFlow 自动进入、刷新 IDLE。
- 每项行为先写失败测试，再写最小实现。
- 仅修改本需求涉及的文件，保留工作区其他改动。
- 每个阶段通过聚焦测试后再进入下一阶段。

## Task 1：修正 UID 增量边界并增加轻量同步选项

**文件**

- 修改：`server/wemail/mail/ImapSmtpMailProvider.test.ts`
- 修改：`server/wemail/mail/ImapSmtpMailProvider.ts`
- 修改：`server/wemail/mail/Mail Core sync worker.test.ts`
- 修改：`server/wemail/mail/Mail Core sync worker.ts`

**步骤**

1. 增加回归测试：当服务器对 `${cursor.uid + 1}:*` 返回当前最高 UID 时，过滤掉 `uid <= cursor.uid`，结果应为空，不应触发 cursor invalid/window fallback。
2. 运行：

   ```powershell
   node --import tsx --test server/wemail/mail/ImapSmtpMailProvider.test.ts
   ```

   预期：新测试失败，证明当前实现会误判 UID 回退。
3. 在 `syncAfterCursor` 中仅保留严格大于 cursor UID 的结果；UIDVALIDITY 改变仍返回 `null`。
4. 增加 `syncIncremental({ repairFlags: false })` 测试，断言不调用 `refreshFlags`。
5. 运行：

   ```powershell
   node --import tsx --test server/wemail/mail/Mail Core sync worker.test.ts
   ```

   预期：新测试失败。
6. 扩展 `SyncIncrementalOptions`，仅当 `repairFlags !== false` 时执行 flag repair。
7. 在新邮件结构化日志中附加可计算时的 `receiveLatencyMs`。
8. 重跑两组测试，预期全部通过。

## Task 2：让 ImapFlow 负责 IDLE 协议细节

**文件**

- 修改：`server/wemail/mail/ImapSmtpMailProvider.test.ts`
- 修改：`server/wemail/mail/ImapSmtpMailProvider.ts`

**步骤**

1. 增加测试覆盖：
   - 客户端配置包含 `maxIdleTime: 240000` 和 `missingIdleCommand: "STATUS"`。
   - 未连接时 `supportsPushWatch()` 为 `false`。
   - 连接后仅当 capability 包含 `IDLE` 时返回 `true`。
   - `waitForMailboxChange()` 收到 `exists` 时 resolve。
   - `close`、`error` 或 abort 时 reject，并清理全部 listener。
   - 等待期间绝不调用手工 `client.idle()`。
2. 运行 provider 测试，确认新增断言先失败。
3. 扩充 ImapLikeClient capability 类型和客户端配置。
4. 从 ImapFlow 实际 capability 判断 IDLE 支持。
5. 重写 `waitForMailboxChange()`，只监听 `exists`、`close`、`error` 和 abort。
6. 重跑 provider 测试，预期全部通过。

## Task 3：将 BackgroundMailWatcher 收敛为薄监督器

**文件**

- 重写：`server/wemail/mail/BackgroundMailWatcher.test.ts`
- 重写：`server/wemail/mail/BackgroundMailWatcher.ts`
- 可能调整：`server/wemail/mail/MailProvider.ts`

**测试场景**

1. `start()` 后立即连接并执行一次轻量增量同步。
2. 支持 IDLE 时：
   - 状态进入 `watching`，`nativeIdle=true`。
   - `exists` 触发一次 `trigger="idle"` 的轻量增量同步。
   - 静默连接每 5 分钟触发安全对账并执行 flag repair。
3. 不支持 IDLE 时：
   - 状态仍为 `watching`，`nativeIdle=false`。
   - 每 60 秒执行一次轻量对账。
4. 连接或监听失败时：
   - 先断开旧连接。
   - 状态进入 `reconnecting`。
   - 按配置的退避序列重试，成功后次数归零。
   - 不会永久降级到不可恢复的 polling 模式。
5. 凭证失效时停止循环并记录错误。
6. `stop()` 中断等待、断开连接，最终状态为 `stopped`。
7. 同步请求串行化，连续事件不会并发执行相同账号同步。
8. 状态时间戳随连接、事件、同步成功和新邮件更新。

**步骤**

1. 用毫秒级测试配置写出上述失败测试，避免真实等待生产间隔。
2. 运行：

   ```powershell
   node --import tsx --test server/wemail/mail/BackgroundMailWatcher.test.ts
   ```

   预期：旧状态机和旧降级逻辑无法满足测试。
3. 将 watcher 状态收敛为：

   ```text
   starting -> watching -> reconnecting -> watching
                                  |
                                  v
                               stopped
   ```

4. 默认参数：
   - IDLE 安全对账：300000 ms。
   - 非 IDLE 对账：60000 ms。
   - 重连：1000、2000、5000、10000、30000、60000 ms。
5. 每次 `connect()` 成功后立即执行 `syncIncremental({ trigger: "syncing", repairFlags: false })`。
6. IDLE 邮箱事件执行 `trigger: "idle", repairFlags: false`。
7. IDLE 安全对账执行 `trigger: "polling"`，保留 flag repair。
8. 非 IDLE 定期对账执行 `trigger: "polling", repairFlags: false`。
9. 所有监听/连接异常先 dispose 旧连接，再进入退避。
10. 重跑 watcher 测试直到全部通过。

## Task 4：暴露 watcher 健康状态

**文件**

- 修改：`server/wemail/bootstrap/AppCompositionTypes.ts`
- 修改：`server/wemail/bootstrap/AppComposition.ts`
- 修改：`server/api/app.ts`
- 修改：`server/api/routes/mailRoutes.ts`
- 修改：`server/api/routes/mailRoutes.test.ts`
- 修改：`app/services/api.ts`

**步骤**

1. 在 route 测试中为 `/sync-status` 增加 watcher 断言：
   - `mode`
   - `nativeIdle`
   - `reconnectAttempts`
   - `lastConnectedAt`
   - `lastMailboxEventAt`
   - `lastSyncSucceededAt`
   - `lastNewMailAt`
   - `lastError`
2. 运行：

   ```powershell
   node --import tsx --test server/api/routes/mailRoutes.test.ts
   ```

   预期：响应尚无 watcher 字段，测试失败。
3. 从 composition 暴露当前账号 watcher。
4. 将 watcher 状态注入 mail routes，并在未启动时返回稳定的 stopped 空状态。
5. 同步更新客户端 `MailSyncStatusResponse` 类型。
6. 重跑 route 测试和 server 类型检查。

## Task 5：集成验证

**聚焦验证**

```powershell
node --import tsx --test server/wemail/mail/BackgroundMailWatcher.test.ts server/wemail/mail/ImapSmtpMailProvider.test.ts server/wemail/mail/Mail Core sync worker.test.ts server/api/routes/mailRoutes.test.ts
```

**全量验证**

```powershell
npm run typecheck:server
npm run test:server
npm run typecheck
```

如前端类型检查覆盖构建链路不足，再运行：

```powershell
npm run build:client
```

**交付检查**

- 检查 `git diff --check`。
- 检查 `git status --short`，确认没有凭证、日志或无关文件。
- 对照设计逐条核验生产默认值和失败恢复路径。
- 提交并推送实现变更。

## 完成定义

- 所有新增回归测试通过。
- 全量 server 测试与类型检查通过。
- 客户端类型检查通过。
- 不再存在“三次 IDLE 失败后永久 polling”的路径。
- 不再手工调用 ImapFlow `idle()`。
- 每次连接成功都会先增量补账。
- `/sync-status` 可以直接判断当前是否处于原生 IDLE、重连或 fallback 对账状态。
