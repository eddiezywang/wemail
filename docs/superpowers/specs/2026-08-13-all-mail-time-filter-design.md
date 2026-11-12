# 所有邮件时间筛选修复设计

## 背景

邮件筛选条件已经按目录隔离：收件箱和所有邮件分别维护自己的筛选状态。当前收件箱中的筛选条件可以正常生效，但所有邮件目录中的时间筛选结果为空或不符合预期。

问题出现在所有邮件使用的虚拟目录查询链路：收件箱直接把筛选参数传入 `useEmails`，而所有邮件通过 `useVirtualEmails` 和 `useAllMailQuery` 查询。现有 all-mail 查询只传递分类和标签，没有传递邮件筛选条件中的时间范围等字段。

本设计只修复筛选参数在所有邮件查询链路中的传递，不改变筛选状态的目录隔离规则，也不改变时间筛选的既有语义。

## 目标与非目标

### 目标

- 使所有邮件目录支持当前目录筛选条件中的时间范围筛选。
- 保持时间筛选语义为“早于 N 天前”:
  - `7d`：早于当前时间 7 天前。
  - `30d`：早于当前时间 30 天前。
  - `180d`：早于当前时间 180 天前。
- 保证所有邮件查询仍然使用 `allMail: "1"`，不退化为单一文件夹查询。
- 保证筛选条件变化能够形成新的查询参数和查询缓存键，从而触发重新查询。
- 保持收件箱与所有邮件筛选条件相互隔离，以及切换目录清除筛选条件的现有行为。

### 非目标

- 不修改时间筛选文案或时间计算方向。
- 不修改后端 SQLite 时间条件。
- 不修改收件箱筛选逻辑。
- 不新增日期选择器或自定义日期范围。
- 不重构虚拟目录体系或邮件列表组件。

## 当前问题定位

当前调用链如下：

```text
所有邮件路由
  -> useVirtualEmails(...)
    -> useAllMailQuery(...)
      -> useEmails({ allMail: "1", category, tag })
        -> api.listDesktopEmails(...)
          -> mailDatabase.listMail(...)
```

所有邮件路由已经取得当前目录的 `filterParams`，但传给 `useVirtualEmails` 的参数目前只包含 URL 中的 `category` 和 `tag`。`useAllMailQuery` 也只接收并转发这两个字段，因此 `olderThan` 在到达 `api.listDesktopEmails` 之前被丢弃。

后端的 `mail.list` 已支持时间筛选，并使用消息的 `received_at_ms` 字段进行条件判断：

```sql
source.received_at_ms < @receivedBefore
```

其中：

```text
receivedBefore = 当前时间 - N * 86400000
```

因此当前故障是前端参数传递缺失，而不是后端 SQL 条件缺失或时间语义错误。

## 设计方案

### 1. 统一 all-mail 查询的筛选参数输入

将 `useAllMailQuery` 和 `useVirtualEmails` 的筛选参数类型从仅支持分类、标签，扩展为可复用的邮件列表筛选参数集合。

建议参数结构：

```ts
interface VirtualMailFilters {
  unread?: string;
  toMe?: string;
  ccMe?: string;
  hasAttachment?: string;
  olderThan?: string;
  category?: string;
  tag?: string;
}
```

实现时应优先复用现有查询参数类型或建立局部窄类型，避免引入与 `MailFilters` 状态对象混淆的类型。该参数表示已经序列化后的查询参数，而不是 UI store 中的布尔值。

### 2. 由 FolderRoute 传入当前目录筛选参数

`FolderRoute` 已通过 `buildMailFilterParams(mailFilters)` 得到当前目录的筛选参数。调用 `useVirtualEmails` 时，将这些参数与已有的 URL 分类、标签参数合并传入。

数据优先级约定：

- 筛选条件来自 `filterParams`。
- 分类、标签来自当前 URL。
- `allMail: "1"` 由 all-mail 查询内部固定添加，调用方不重复传递。

这样可以确保 all-mail 查询获得与普通文件夹查询相同的筛选条件，同时仍保留所有邮件的目录范围。

### 3. 在 useAllMailQuery 中逐项转发参数

`useAllMailQuery` 构造 `useEmails` 参数时保留：

```ts
{
  page: "1",
  allMail: "1",
  ...filterParams,
  ...(category ? { category } : {}),
  ...(tag ? { tag } : {}),
}
```

不直接把未知字段全部透传到后端；应明确转发当前邮件列表 API 支持的字段，避免 UI 或路由参数污染数据库查询。

预期时间筛选请求示例：

```ts
{
  allMail: "1",
  olderThan: "30d"
}
```

### 4. 保持查询缓存隔离

`useEmails` 会使用完整查询参数生成邮件列表 query key。因此只要 `olderThan` 被传入 all-mail 查询，选择不同时间条件就会产生不同的 query key，并触发对应查询。

需要确认 all-mail 的 query key 包含完整参数，而不是只包含 `allMail`、分类或标签。若现有 query key 构造遗漏筛选字段，应在同一修复范围内补齐；不得通过手动 invalidate 所有邮件查询来掩盖参数未进入 query key 的问题。

## 数据流

```text
UI 选择“一个月前”
  -> 当前目录 mailFilters.olderThan = "30d"
  -> buildMailFilterParams()
  -> FolderRoute 将 olderThan 传给 useVirtualEmails()
  -> useAllMailQuery 构造 { allMail: "1", olderThan: "30d" }
  -> useEmails 生成包含 olderThan 的 query key
  -> api.listDesktopEmails()
  -> MailCoreListParams.olderThan = "30d"
  -> MailDatabaseQueryRepository.list()
  -> received_at_ms < Date.now() - 30 * 86400000
```

清除筛选条件时，`olderThan` 从参数对象中消失，all-mail 查询回到未按时间筛选的结果。切换目录时仍由既有目录作用域逻辑清理筛选状态，本设计不改变该流程。

## 边界与错误处理

- 仅允许现有值 `7d`、`30d`、`180d` 进入 all-mail 查询。
- 空值、`null`、未识别值不应生成 `olderThan` 参数。
- 不在前端重新计算时间戳；继续由数据库查询层基于请求执行时的 `Date.now()` 计算截止时间。
- 若数据库查询失败，沿用现有邮件列表错误处理和重试入口。
- 不删除或改写已有 query cache，避免影响目录切换时的筛选隔离。

## 测试设计

### 单元测试

扩展 all-mail 虚拟目录查询测试，验证：

1. 传入 `olderThan: "30d"` 时，调用 `api.listEmails` 的参数同时包含 `allMail: "1"` 和 `olderThan: "30d"`。
2. `unread`、`toMe`、`ccMe`、`hasAttachment` 能够与 `olderThan` 一起传递。
3. 未传筛选条件时，参数不包含这些可选字段。
4. 分类和标签仍然保留。

### 查询缓存测试

验证 `olderThan: "7d"` 与 `olderThan: "30d"` 产生不同的邮件列表查询 key，切换条件后不会复用错误的 all-mail 结果。

### 回归测试

- 收件箱时间筛选仍传递 `olderThan`。
- 收件箱和所有邮件可以拥有不同的筛选条件。
- 从收件箱切换到所有邮件时，筛选状态仍按既定规则清除。
- 清除所有邮件筛选条件后，列表恢复未筛选结果。

### 手工验收

在所有邮件目录中依次选择：

- 一个星期前：只显示早于当前时间 7 天的邮件。
- 一个月前：只显示早于当前时间 30 天的邮件。
- 六个月前：只显示早于当前时间 180 天的邮件。

然后清除筛选条件，列表恢复到所有邮件的未筛选结果。检查开发日志中的 `listDesktopEmails` 参数或数据库请求，确认请求包含对应的 `olderThan` 值。

## 涉及文件

预计修改：

- `app/queries/virtualFolders.ts`
- `app/routes/folder.tsx`
- `app/queries/virtualFolders.test.tsx`
- 如 query key 未覆盖筛选参数，再修改对应的邮件查询 key 实现和测试文件。

不修改：

- `server/wemail/database/MailDatabaseQueryRepository.ts`
- `app/components/wemail/MailFilterPopover.tsx`
- `app/hooks/useMailFilters.ts`

## 验收标准

- 所有邮件选择任一时间筛选后，实际请求携带正确的 `olderThan` 值。
- 结果按“早于 N 天前”过滤，不改变语义方向。
- 收件箱既有筛选行为不回归。
- 所有邮件的其他筛选条件与时间筛选可以组合使用。
- 清除筛选条件后所有邮件列表恢复正常。
- 相关单元测试覆盖参数传递和查询缓存隔离。
