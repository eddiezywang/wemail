# Live UI Regression (agent-desktop)

对**运行中、已登录**的 WeMail 桌面实例执行真实 UI 交互回归。驱动器：
`agent-desktop`（Windows 可访问性树 CLI，快照 → 匹配 → 点击 → 验证）。

## 运行

```bash
node tests/live/ui/01-list-detail-navigation.mjs   # 逐个执行
node tests/live/ui/02-mail-detail.mjs
node tests/live/ui/03-settings-navigation.mjs
node tests/live/ui/04-centers-navigation.mjs
```

前置条件：WeMail 桌面端运行中且已登录；`agent-desktop` 全局安装；
在交互桌面会话内执行（非服务会话）。

**启动要求**：实例必须带 `--force-renderer-accessibility` 启动（渲染器
可访问性常开），否则快照会间歇性超时/退化为空树。lib 的 `steps()` 会在
每步前 `ensureVisible()`（restore + focus），以免疫外部最小化。

## 覆盖范围

| 脚本 | 覆盖 |
|------|------|
| `01-list-detail-navigation` | 收件箱入口/写邮件按钮、文件夹切换（收件箱↔已发送）、列表渲染、通讯录导航 + 搜索框 |
| `02-mail-detail` | 打开邮件行 → 详情工具栏（回复等动作）→ 标记未读恢复（best-effort，按主题片段定位行按钮） |
| `03-settings-navigation` | 设置对话框 8 个主分区（账户/个性化 AI/模型/MCP/连接/Skill Center/关于/高级设置）逐个渲染 + 关闭 |
| `04-centers-navigation` | 应用消息中心、自动化工作台导航 + 离开收件箱验证 |

## 已知限制

- `listMail` reader 不返回 Sent 等非 INBOX 文件夹内容（该构建限制）；
  Sent 验证走 folder totalCount。
- 行悬停工具栏（加星标/移到回收站/标记为未读）在无鼠标悬停时出现与否
  不稳定——02 的"标记未读恢复"为 best-effort，不计入失败。
- 打开邮件会把真实邮件标记为已读（02 内恢复为 best-effort）。
- trash/move 需要对应目标文件夹存在，fixture/live 场景按需选择。
- **中文孪生链接**：「已发送」(编码路径) 与「Sent」(/folder/sent) 是同名
  孪生链接，UIA 拒绝歧义 ref（AMBIGUOUS_TARGET）——文件夹切换用唯一名
  （如「告警」）或 value 精确匹配。
- 打开邮件会把真实邮件标记为已读（02 内恢复为 best-effort）。

## 稳定性经验

- 不要用 `find --text` 做交互定位：web UI 持续变化会让 locator 无法稳定
  （TIMEOUT / identity_not_unique）。用「快照一次 + 本地遍历树 JSON 匹配 +
  引用点击 + 失败重快照重试」（见 `lib.mjs` 的 `snapshotMatch`/`clickMatch`）。
- 快照偶发失败（env.ok=false）必须重试；`snapshotMatchAll` 失败返回空集。
- 批次间有状态依赖（设置弹窗未关会影响下一批）——每个批次的第一个步骤
  做防御性复位（如关闭残留弹窗）。
