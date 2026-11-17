# 邮件列表双向滑动分页实施计划

> For agentic workers: 按任务逐项执行，每项先补失败测试，再实现最小代码。

**目标：** 将所有邮件视图统一为每次 50 封的服务端分页列表，支持向下连续加载、顶部刷新、失败重试和滚动位置保持。

**架构：** 保留现有 Electron、React Router、TanStack Query 和 SQLite。数据库统一提供稳定游标分页，前端普通目录、虚拟目录和搜索统一向列表组件暴露无限查询能力。

**技术栈：** React、React Router、TanStack Query、TypeScript、SQLite、Vitest。

## 全局约束

- 每次加载 50 封。
- 向下加载直到服务端没有更多。
- 顶部下拉超过 64px 才刷新。
- 新邮件直接插入顶部并保持滚动位置。
- 分页失败自动重试 3 次，失败后保留已加载数据。
- 所有虚拟目录必须使用服务端数据源。
- 搜索或筛选变化后从第一批重新开始。

## Task 1：共享分页协议

文件：shared/wemail/mailCoreProtocol.ts、shared/wemail/mailDatabaseProtocol.ts、server/wemail/database/MailDatabaseQueryRepository.test.ts。

新增 scope、cursor、hasMore 等字段，约定目录查询的稳定游标和统一返回结构。先增加协议测试，确认完整页面能返回 hasMore 和 nextCursor，再修改类型。

## Task 2：数据库稳定游标和虚拟目录

文件：server/wemail/database/MailDatabaseQueryRepository.ts 及其测试。

为普通文件夹、所有邮件、星标、稍后处理、订阅、待办、标签增加服务端 scope。邮件型 scope 应用相同筛选条件、limit 50、稳定排序和游标。待办和已计划使用各自 todo/outbox 数据模型的服务端分页接口；待办只读取已有智能分析产物；订阅只读取持久化邮件头投影；已计划只读取未来待发送记录。

## Task 3：桌面 API 参数传递

文件：app/services/api.ts、shared/wemail/mailCoreProtocol.ts、app/queries/virtualFolders.test.tsx。

将 scope、cursor、hasMore 以及现有筛选条件从渲染器传到数据库。保留所有邮件 allMail 语义和现有筛选参数，不在 API 层重新计算时间。

## Task 4：普通目录和虚拟目录无限查询

文件：app/queries/emails.ts、app/queries/virtualFolders.ts、app/queries/keys.ts 及测试。

移除 maxPages 4 限制，使用服务端 hasMore/nextCursor 判断下一页。扁平化页面时按逻辑邮件 ID 去重。配置后续分页自动重试 3 次，首屏错误继续沿用现有错误状态。虚拟目录改为直接使用对应服务端 scope。

## Task 5：搜索无限查询

文件：app/queries/search.ts、app/routes/inbox.tsx、app/routes/folder.tsx、app/routes/smart-tags.tsx、app/queries/keys.ts 及测试。

将搜索从单页 useQuery 改为 useInfiniteQuery，固定每页 50 封，第二页携带相同关键词、范围和筛选参数。列表条件变化依赖新 query key，从第一批重新开始。

## Task 6：列表底部连续加载

文件：app/routes/_workbench.tsx 及测试。

复用现有列表滚动容器，在距离底部 240px 时调用 fetchNextPage。添加加载中、失败可重试和已加载全部邮件状态。分页失败不覆盖已有邮件。

## Task 7：顶部下拉刷新和滚动锚定

文件：app/routes/_workbench.tsx、app/queries/emails.ts、app/queries/search.ts 及测试。

增加顶部拖动阈值 64px，刷新当前完整查询。按逻辑 ID 去重，将新增行插入顶部，使用刷新前后 scrollHeight 差值修正 scrollTop。刷新失败保持原列表，禁止与底部加载并发。

## Task 8：验证和范围审查

执行 git diff --check、相关 server/renderer 类型检查和用户授权的聚焦测试。检查未修改生成目录、Electron 架构和无关本地改动。
