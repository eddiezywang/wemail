# WeMail 五人团队 Linear + GitHub 协作流程设计

## 目标

将 WeMail 五人团队从飞书多维表格驱动的人工协作流程，切换为：

- Linear 管理需求、Bug、优先级、负责人、每周计划和验收；
- GitHub 管理私有代码仓库、分支、Pull Request、CI 和发布；
- 飞书只保留长文档、会议纪要、内部资料和旧流程的只读历史。

迁移后应同时解决：

1. 无法快速了解每个人正在做什么、何时完成；
2. Bug 和需求容易遗漏，开发、评审与验收缺少闭环；
3. 功能、代码分支、提交、PR 和发布之间没有稳定关联；
4. 每周需要人工整理进度与周报。

## 当前流程诊断

现有飞书多维表包含四张主要表：

- “功能进度”：记录大功能、模块、负责人、状态和优先级；
- “todo list”：记录具体开发事项、处理人和修复状态；
- “问题记录”：再次记录 Bug、需求、优化、严重程度和解决情况；
- “周报记录”：人工填写本周工作、下周计划、风险和文档链接。

主要问题是相同工作散落在功能、Todo 和问题三类记录中，字段和状态重复，父子关系依赖人工维护。代码仓库中的分支、提交、测试与这些记录没有自动关联，因此实际进度和周报仍需人工同步。

## 工具职责边界

### Linear

Linear 是团队工作状态的唯一事实来源，负责：

- 新需求、Bug 和改进的收集与 Triage；
- 优先级、负责人、工作量和验收人的确定；
- Project、Cycle、Issue 和状态管理；
- 阻塞、验收与每周进度记录。

### GitHub

GitHub 是代码交付状态的唯一事实来源，负责：

- 私有 Git 仓库；
- 分支、提交和 Pull Request；
- 代码评审、协作规则和 CI 结果；
- CI、版本标签、安装器构建和 Release。

### 飞书

飞书继续用于：

- 长文档、会议纪要和内部资料；
- 即时沟通；
- 原有多维表格在过渡完成后的只读历史档案。

聊天中的最终结论必须回写到对应的 Linear Issue、Project 或 GitHub PR。启用新流程后，不再向原有功能、Todo、问题和周报表新增任务记录。启用日仍未完成的旧记录只允许更新进度直至关闭，全部关闭后将旧表改为只读。

## Workspace 与 Team

- Linear Workspace 名称：`WeMail`。
- 只创建一个 Team：`WEM`。
- 五名成员全部加入该 Team。
- 初期不按前端、后端、AI 或测试拆分 Team。
- 初期不启用 Initiative。

单 Team 可以让所有成员共享同一套状态、Cycle 和容量视图，避免五人团队因为组织层级过多而增加协调成本。

## 工作项层级

### Project

Project 代表具有明确结果和结束日期的阶段目标，例如：

- `0.2 内测版稳定性`
- `智能助手可用性提升`
- `邮件实时同步可靠性`
- `企业通讯录与收件人体验`
- `自动化规则正式可用`

每个 Project 必须包含：

- 一名负责人；
- 目标与非目标；
- 目标完成日期；
- 可验证的成功标准；
- 所属 Issue；
- 每周状态更新。

控制规则：

- 同时进行的 Project 不超过 3 个；
- 一个 Project 通常持续 2 至 6 周；
- 超过 8 周时拆分为多个阶段；
- 没有结束条件的永久模块不能创建为 Project；
- Project 状态由负责人根据目标达成情况更新，不能只根据 Issue 是否全部完成自动判定。

### Issue

Issue 是可排期、可指派、可验收的最小工作单元。单个 Issue 不应超过一个 Cycle；接近一周的事项必须优先拆分。

## Issue 类型与标签

Issue 类型使用标签表示：

- `Bug`：已有行为不符合预期；
- `Feature`：新增用户能力；
- `Improvement`：优化已有功能；
- `Tech Debt`：重构、可靠性、性能和测试债务；
- `Chore`：构建、CI、依赖和文档等维护工作。

永久模块使用互斥的 `Area` 标签组：

- `Desktop UI`
- `Mail Sync`
- `Mail Display`
- `Compose`
- `Search`
- `AI Summary`
- `AI Tags`
- `Agent`
- `Automation`
- `Infrastructure`

每个 Issue 最多选择一个主要 `Area`。

公共标签只保留：

- `Blocked`
- `Security`
- `Performance`
- `Regression`
- `Needs Design`

不创建与 Linear 原生字段重复的优先级、状态、负责人、Cycle 或版本标签。

## 优先级

使用 Linear 原生优先级：

- `Urgent`：线上阻断、数据安全问题或核心功能完全不可用，允许插入当前 Cycle；
- `High`：影响主要流程，应优先进入最近 Cycle；
- `Medium`：正常排期的默认级别；
- `Low`：体验优化或非紧急事项；
- `No priority`：尚未完成 Triage，不得进入 Cycle。

新建 Issue 不通过标签继续使用旧的 P0/P1/P2/P3 表达方式。

## 工作量估算

使用 `1、2、3、5、8` 点：

- `1`：数小时内；
- `2`：约半天；
- `3`：约一天；
- `5`：约两至三个工作日；
- `8`：接近一周，应优先拆分。

超过 `8` 点的工作不能作为单个 Issue 进入 Cycle，应拆成子 Issue 或提升为 Project。

点数只用于团队容量预测，不用于个人绩效评价。前 3 个 Cycle 只收集数据；从第 4 个 Cycle 起，以最近 3 个 Cycle 的平均完成点数作为容量参考。

## Issue 模板

所有 Issue 使用以下基础结构：

```markdown
## 背景
为什么要做，问题来自哪里。

## 目标
完成后用户或系统应得到什么结果。

## 验收标准
- [ ] 可验证的结果一
- [ ] 可验证的结果二

## 非目标
这次明确不解决什么。

## 验收人
Bug 填报告人；需求和优化填需求负责人。
```

Bug 额外包含：

```markdown
## 复现步骤
1.
2.

## 预期结果

## 实际结果

## 环境
版本、操作系统、邮箱类型等。
```

### Definition of Ready

Issue 只有同时具备以下内容才能进入 Cycle：

- 类型；
- 明确优先级；
- 开发负责人；
- 验收人；
- 工作量估点；
- 可验证的验收标准。

### Definition of Done

Issue 只有同时满足以下条件才能进入 `Done`：

- 实现已合并至 `main`；
- CI 全部通过；
- PR 讨论已解决；
- 验收标准逐项确认；
- 指定验收人已经通过验收。

PR 合并不等于 Issue 完成。

## Issue 状态流

```text
Triage
  ↓ 团队负责人确认类型、优先级和是否值得做
Backlog
  ↓ 排入本周 Cycle
Ready
  ↓ 开发者开始处理
In Progress
  ↓ 创建 Pull Request
In Review
  ↓ PR 合并且 CI 通过
待验收
  ├─ 验收通过 → Done
  └─ 验收失败 → In Progress
```

补充状态：

- `Canceled`：决定不做；
- `Duplicate`：与已有 Issue 重复。

责任规则：

- 所有新 Issue 一律进入 Triage；
- 团队负责人固定负责 Triage、优先级和 Cycle 排期；
- 其他成员可以提交 Issue，但不能自行承诺排期；
- Bug 在“待验收”时重新指派给报告人；
- Feature 和 Improvement 在“待验收”时重新指派给需求负责人；
- 验收失败时必须评论具体失败项，然后退回 `In Progress`；
- 开发者不能在未验收时自行关闭 Issue。

## 每周 Cycle

配置：

- 周期长度：1 周；
- 每周一开始；
- 时区：`Asia/Shanghai`；
- 开启未完成 Issue 自动滚入下一 Cycle。

### 周一：计划会

时长 30 至 45 分钟：

1. 团队负责人清理 Triage；
2. 回顾上周未完成事项；
3. 从 Backlog 选择本周 Issue；
4. 确认负责人、优先级、估点和验收人；
5. 只安排约 80% 的预计容量，保留约 20% 处理突发 Bug 和评审。

### 周二至周四：执行

- 不要求另外填写日报；
- 每人同时只保持一个主要 Issue 在 `In Progress`；
- 阻塞时添加 `Blocked` 标签并评论原因；
- Issue 超过一个工作日没有可见进展时，负责人更新简短评论；
- 阻塞超过两个工作日，主动升级给团队负责人处理。

### 周五：验收与回顾

时长 30 至 45 分钟：

1. 检查已合并但仍在“待验收”的事项；
2. 由报告人或需求负责人完成验收；
3. 回顾完成点数、未完成原因和紧急插单数量；
4. 在 Cycle 中补充本周成果、风险和下周重点；
5. 不再手工逐项填写飞书周报。

滚动规则：

- 未完成 Issue 可以自动滚入下一 Cycle；
- 连续滚动两次时必须拆分、缩小范围或退回 Backlog；
- `Urgent` Issue 插入当前 Cycle 时，应移出一个相近工作量的普通 Issue，避免隐性扩大承诺。

## GitHub 仓库与权限

- 在团队 GitHub Organization 下创建私有仓库 `wemail`；
- 从当前内网仓库迁移完整提交历史和仍需保留的分支；
- GitHub Organization 使用 Free 计划，仓库保持 Private；
- 使用 `main` 作为默认分支；
- 团队规则禁止直接推送至 `main`；
- 所有代码变更通过 Pull Request；
- 每个 PR 至少由一名非作者成员批准；
- 所有必需 CI 检查通过后才能合并。

GitHub Free 不支持为 Organization 私有仓库强制启用分支保护、必需审批和必需状态检查。因此上述 PR、审批、讨论解决和 CI 规则在试运行期属于团队流程约束，由固定负责人 `eddiezywang` 在合并前检查，不能描述为 GitHub 的技术性拦截。不得为了获得免费分支保护而公开仓库，也不启用 GitHub Team 试用。

## Linear 与 GitHub 关联

每个代码分支和 PR 必须包含 Linear Issue ID：

```text
Issue: WEM-123
Branch: wem-123-fix-mail-sync
PR: [WEM-123] Fix mail sync reconnection
```

状态自动化：

- 创建分支：`Ready → In Progress`
- 创建 PR：`In Progress → In Review`
- PR 合并且 CI 通过：`In Review → 待验收`
- PR 关闭但未合并：退回 `In Progress`

禁止配置“PR 合并后自动 Done”。

## Pull Request 标准

PR 合并前必须满足：

- 至少一名非作者成员批准；
- 所有讨论已解决；
- 分支与最新 `main` 无冲突；
- 必需 CI 检查通过；
- UI 改动附截图；
- Bug 修复包含回归测试，或说明无法自动化测试的原因；
- 描述中包含对应 Linear Issue；
- 描述中列出验证命令和结果。

必需 CI 至少包括：

- 服务端 TypeScript 检查；
- Electron TypeScript 检查；
- 服务端测试；
- Renderer 测试；
- 受影响的打包脚本测试。

## 发布

- 只有已经通过验收的 Issue 才能计入 Release；
- 使用语义化版本标签，例如 `v0.1.2`；
- GitHub Actions 根据版本标签生成 Windows 安装器；
- Release Notes 从该版本关联的 Linear Issue 汇总；
- 发布失败单独创建 `Bug`，不批量重新打开已经验收的 Issue。

## 团队视图

建立以下共享视图：

- `本周 Cycle`：按状态分组；
- `我的工作`：当前 Cycle 中分配给自己的 Issue；
- `待验收`：所有已合并但未验收的事项；
- `Blocked`：所有受阻事项；
- `开放 Bug`：所有未完成 Bug，按优先级排序；
- `未分配 Backlog`：没有负责人或估点的候选事项；
- `本周插单`：Cycle 开始后才加入的 Issue。

## 通知和沟通

- 被指派、被提及或被请求 PR 评审时必须通知；
- 普通状态变化不发送全员通知；
- 仅 `Urgent` Issue 使用紧急通知；
- 飞书群继续用于即时沟通；
- 决策、范围变化、阻塞原因和验收结果必须回写到 Linear Issue 或 GitHub PR。

## 异常处理

- CI 失败：保持 `In Review`，由开发者修复；
- PR 评审不通过：保持 `In Review`；
- 验收不通过：评论失败项并退回 `In Progress`；
- 连续跨两个 Cycle：拆分、缩小范围或退回 Backlog；
- 已完成后发现同类问题：新建带 `Regression` 标签的 Bug，并关联原 Issue；
- Backlog 超过 30 天未被选择：重新评估并明确保留或取消。

## 数据迁移

采用“从零开始”策略：

- 不把飞书历史任务导入 Linear；
- 启用日期之前已经完成的功能、Todo、问题和周报直接作为飞书历史档案；
- 启用日期之后的所有新工作只进入 Linear；
- 启用日仍未完成的旧工作继续在飞书中更新进度直至关闭，不在 Linear 重建；
- 旧工作在启用日后新增的独立范围、回归问题或后续需求，必须作为新的 Linear Issue 创建。

旧记录全部关闭后，将原有多维表设为只读。该策略避免重复数据、错误状态和历史字段污染新流程。

## 免费版容量策略

团队使用 Linear 免费版：

- 五名成员全部加入同一个 Team；
- 不创建额外 Team；
- 每月检查 Issue 总数；
- 到 180 个 Issue 时评估增长速度和剩余容量；
- 到 220 个 Issue 时必须决定升级或更换方案；
- 不通过删除历史 Issue 规避容量限制。

免费版用于验证流程是否有效。流程本身不能为了减少 Issue 数量而合并不相关工作或放弃必要的验收记录。

## 上线成功标准

新流程运行四周后，应满足：

- 100% 的代码 PR 关联 Linear Issue；
- 没有验收人的 Issue 不进入 Cycle；
- 团队不再人工逐项维护飞书周报；
- 可以随时看到五名成员当前工作、阻塞和待验收事项；
- Bug 从报告、修复、PR 到验收有完整记录；
- 能依据最近三个 Cycle 的完成数据预测下一周容量；
- 功能、代码变更和发布版本之间可以相互追溯。

## 非目标

- 不把飞书所有文档迁移到 Linear；
- 不迁移旧多维表中的历史任务；
- 不在初期拆分多个 Linear Team；
- 不在初期使用 Initiative；
- 不使用点数进行个人绩效评价；
- 不让 PR 合并自动跳过业务验收；
- 不在本设计阶段创建外部账号、Organization、仓库或 Linear Workspace。
