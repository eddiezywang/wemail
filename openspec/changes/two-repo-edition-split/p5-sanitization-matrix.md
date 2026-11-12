# P5 公开前消毒分级矩阵

依据 `scripts/public-boundary-baseline.json`（103 个文件 / 356 处命中）逐文件核对后的处置分级。本文档本身会被门禁扫描，因此全文只描述命中类型（组织名 / 内网域名 / 内网 registry / 内部品牌 / 被封禁上游名 / 内部或私网 IP），不引用任何命中原文；两个文件名本身含组织名的文件以"目录 + 功能"描述代替完整路径。

分类口径：

- **A** 随 P2 模块抽离整体消失（发票/额度、WeCLI、企业通讯录、办公场景检测四模块；文件迁往闭源仓，或文件保留但命中所在分支随模块移除）
- **B** 文档/注释消毒（叙述性内容改为通用措辞或占位符）
- **C** 测试夹具泛化（示例域名/邮箱/IP/URL 换成 example 域或 RFC 5737 文档保留地址）
- **D** 配置外置（硬编码值改由 edition/env/overlay 承接，开源位留空或必填）
- **E** 直接删除（纯内部材料：验收清单、内部 TODO、内网迁移记录、内部支持知识库）
- **F** 存疑（需人工裁定）

## 汇总

| 类别 | 文件数 | 命中数 | 说明 |
| --- | --- | --- | --- |
| A 随 P2 抽离消失 | 29 | 53 | 发票/WeCLI/通讯录/场景检测相关代码、测试与设计文档 |
| B 文档/注释消毒 | 25 | 78 | openspec 变更叙述、superpowers 计划/设计稿、构建文档、代码注释示例 |
| C 测试夹具泛化 | 29 | 177 | 各类单测/E2E 中的示例邮箱、域名、URL、地址夹具 |
| D 配置外置 | 5 | 7 | 更新源地址白名单、下载地址默认值、可信图片域后缀 |
| E 直接删除 | 14 | 40 | 内部验收清单、内网迁移记录、内部支持服务知识库与评测集 |
| F 存疑 | 1 | 1 | 嵌套锁文件哈希误报，需修门禁跳过逻辑 |
| **合计** | **103** | **356** | 与基线一致 |

**P2 完成后剩余**：356 − 53 = **303 处 / 74 个文件**，全部由 P5 消毒清零。
其中 `DirectoryRepository.test.ts` 的 67 处里，服务层用例预计随通讯录抽离部分迁出（估 20–35 处），P5 实际夹具消毒量约降至 **270–285 处**。

## A 类明细（29 文件 / 53 处）

| 文件 | 计数 | 类别 | 处置动作 |
| --- | --- | --- | --- |
| app/components/AgentPanel.tsx | 4 | A | WeCLI 安装确认弹窗（安装命令与网络限制提示）随 WeCLI UI 安装流程抽离，面板本体保留 |
| app/components/EmailAttachmentList.tsx | 1 | A | 发票刷新未登录时跳转内部补贴平台的链接分支随发票模块抽离 |
| app/components/EmailAttachmentList.test.tsx | 1 | A | 上一条对应链接断言随分支删除 |
| app/components/compose/DirectoryRecipientInput.test.tsx | 3 | A | 通讯录收件人输入组件随企业通讯录模块抽离，测试随之迁出 |
| app/components/directory/DirectoryContactTable.test.tsx | 2 | A | 通讯录联系人表格组件随模块抽离 |
| app/components/directory/DirectoryTree.test.tsx | 3 | A | 通讯录组织树组件随模块抽离 |
| app/components/wemail/PendingActionCard.tsx | 2 | A | WeCLI 安装提示与补贴平台登录链接属发票/WeCLI 专属分支，随模块移除，通用卡片保留 |
| app/components/wemail/PendingActionCard.test.tsx | 3 | A | 上述分支的用例随模块迁出 |
| docs/superpowers/plans/2026-07-08-allowance-monthly-invoice.md | 1 | A | 月度发票实现计划随发票模块迁往闭源仓（或删除） |
| docs/superpowers/specs/2026-07-08-allowance-monthly-invoice-design.md | 1 | A | 月度发票设计稿随模块迁往闭源仓（或删除） |
| docs/superpowers/specs/2026-07-24-enterprise-directory-browser-design.md | 2 | A | 企业通讯录浏览器设计稿随模块迁往闭源仓（或删除） |
| server/wemail/agent/AllowanceMonthlyInvoiceSkill.ts | 1 | A | 发票技能实现整体迁出 |
| server/wemail/agent/AllowanceUploadReceipt.ts | 1 | A | 回执上传逻辑随发票模块迁出 |
| server/wemail/agent/AllowanceUploadReceipt.test.ts | 1 | A | 对应测试迁出 |
| server/wemail/agent/MailActionExecutor.ts | 1 | A | WeCLI 安装未完成提示分支随 WeCLI 抽离移除，执行器本体保留 |
| server/wemail/agent/MailAgentTools.ts | 4 | A | WeCLI 工具的缺装提示、网络限制描述等文案随工具注册一起迁出 |
| server/wemail/agent/PiAgentRuntime.ts | 1 | A | 系统提示词中的 WeCLI 可选依赖段（内部提示块）随 P2.5 抽离 |
| server/wemail/agent/PiAgentRuntime.test.ts | 1 | A | 对应提示词断言随提示块迁出 |
| server/wemail/agent/WemailAgentTools.directory.test.ts | 3 | A | 通讯录相关 agent 工具测试随模块迁出 |
| server/wemail/agent/skills/allowance-monthly-invoice.md | 1 | A | 技能提示文档随发票模块迁出 |
| server/wemail/directory/DirectoryService.ts | 1 | A | 服务内部的企业域名判断默认值随企业通讯录抽离（本地存储层保留在开源树） |
| server/wemail/intelligence/officeSceneDetection.ts | 1 | A | 办公场景检测整体迁出（P2.5） |
| server/wemail/intelligence/officeSceneDetection.test.ts | 1 | A | 对应测试迁出 |
| server/wemail/mcp/McpDirectoryContactProjection.test.ts | 3 | A | MCP 通讯录联系人投影测试随模块迁出 |
| server/wemail/skills/WecliInstaller.ts | 3 | A | WeCLI 安装器（包名与内网源常量）整体迁出 |
| server/wemail/skills/WecliInstaller.test.ts | 1 | A | 对应测试迁出 |
| server/wemail/skills/WecliSetupService.ts | 2 | A | WeCLI 安装服务（安装命令与用户目录下技能路径）整体迁出 |
| server/wemail/skills/WecliSetupService.test.ts | 1 | A | 对应测试迁出 |
| shared/wemail/wecliCatalog.ts | 3 | A | WeCLI 命令目录常量（下载地址与包名）随 WeCLI 运行时抽离 |

## B 类明细（25 文件 / 78 处）

| 文件 | 计数 | 类别 | 处置动作 |
| --- | --- | --- | --- |
| AGENTS.md | 1 | B | 开发环境说明中的本机仓库路径改为占位路径 |
| docs/build/desktop-updates.md | 1 | B | 更新服务器示例地址改占位（与 D 类配置外置联动） |
| docs/build/windows-build.md | 3 | B | 构建文档中的更新源地址示例全部改占位 |
| docs/superpowers/plans/2026-07-03-imap-connection-resilience.md | 5 | B | 企业邮箱主机相关表述改为"目标企业邮箱/生产 IMAP 服务"等中性措辞 |
| docs/superpowers/plans/2026-07-07-workbench-resizable-panels.md | 7 | B | 本机绝对路径统一改为占位 |
| docs/superpowers/plans/2026-07-26-unified-mail-credential-recovery.md | 4 | B | 企业邮箱错误分支的表述通用化 |
| docs/superpowers/plans/2026-07-30-official-docs-follow-up-polish.md | 1 | B | 提供商清单中的企业邮箱名改中性表述 |
| docs/superpowers/plans/2026-07-30-official-docs-homepage-polish.md | 4 | B | 落地页演示文案中的内部系统名改中性示例 |
| docs/superpowers/specs/2026-07-15-mail-password-gap-recovery-design.md | 2 | B | 现场数据叙述中的企业邮箱与主机标识通用化 |
| docs/superpowers/specs/2026-07-15-metadata-first-background-body-sync-design.md | 1 | B | 运行态验证段落的主机名改占位 |
| docs/superpowers/specs/2026-07-26-unified-mail-credential-recovery-design.md | 5 | B | 企业邮箱密码错误分类的叙述通用化 |
| docs/superpowers/specs/2026-07-27-persisted-recipient-directory-display-design.md | 1 | B | 展示示例中的企业邮箱地址换 example 域 |
| docs/ui-explore/component-upgrades-comparison.html | 2 | B | 演示对比页的示例收件人换 example 域 |
| openspec/changes/agent-chat-runtime-ui-overhaul/ACCEPTANCE.md | 1 | B | 验收记录中的本机路径占位化 |
| openspec/changes/fix-imap-background-session-ownership/design.md | 3 | B | 企业邮箱验收表述通用化 |
| openspec/changes/fix-imap-background-session-ownership/tasks.md | 1 | B | 同上 |
| openspec/changes/streamline-realtime-mail-refresh/design.md | 13 | B | 全文企业邮箱叙述替换为中性表述（本类最大单点） |
| openspec/changes/streamline-realtime-mail-refresh/proposal.md | 4 | B | 同上 |
| openspec/changes/streamline-realtime-mail-refresh/specs/mail-sync/spec.md | 3 | B | 同上（含需求标题与场景措辞） |
| openspec/changes/streamline-realtime-mail-refresh/tasks.md | 5 | B | 同上 |
| scripts/verify-free-trial.ts | 1 | B | 命令行示例输出中的企业邮箱换 example 域 |
| server/wemail/activation/freeTrialResource.ts | 1 | B | 注释中"仅限某企业邮箱域"的示例改中性表述（域名白名单本身走 env） |
| services/free-trial-issuer/README.md | 2 | B | 内部网关地址示例改占位，默认值说明改为必填 env |
| services/free-trial-issuer/server.ts | 3 | B | 注释中的企业域名示例改中性 |
| website/src/components/landing/InvoiceHeroDemo.astro | 4 | B | 落地页演示数据中的内部系统名改中性示例；若开源版落地页不展示该能力则整段删除 |

## C 类明细（29 文件 / 177 处）

| 文件 | 计数 | 类别 | 处置动作 |
| --- | --- | --- | --- |
| app/components/EmailIframe.test.tsx | 1 | C | 正文链接夹具换 example 域 |
| app/components/MailCredentialDialog.test.tsx | 11 | C | 企业预设夹具（邮箱/主机/用户名）换通用示例预设 |
| app/components/compose/AiPromptBar.test.tsx | 4 | C | 收件人夹具换 example 域 |
| app/components/compose/ComposeBody.test.tsx | 2 | C | 收件人夹具换 example 域 |
| app/components/editor/RichTextEditor.test.tsx | 2 | C | 粘贴链接夹具换 example 域 |
| app/components/email-panel/RecipientDetails.test.tsx | 8 | C | 联系人邮箱夹具换 example 域 |
| app/components/settings/sections/ModelSection.test.tsx | 1 | C | allowedDomains 夹具换 example 域 |
| app/components/wemail/EmailIntelligenceCard.test.tsx | 8 | C | 正文/链接/邮箱夹具换 example 域 |
| app/lib/external-links.test.ts | 2 | C | URL 夹具换 example 域 |
| app/lib/utils.test.ts | 1 | C | 账号邮箱夹具换 example 域 |
| electron/main/electron-updater-adapter.test.ts | 7 | C | 更新源地址夹具换文档保留地址段 |
| electron/main/external-links.test.ts | 2 | C | URL 夹具换 example 域 |
| electron/main/update-network.test.ts | 2 | C | 更新源夹具随 D 类外置后换示例地址 |
| electron/main/update-policy.test.ts | 3 | C | 同上 |
| scripts/update-release-config.test.ts | 6 | C | 同上 |
| server/wemail/agent/ActionExecutionRepository.test.ts | 1 | C | stderr 夹具中的内部站点登录提示换 example 域 |
| server/wemail/agent/ActionExecutionService.test.ts | 1 | C | 同上 |
| server/wemail/agent/WemailAgentTools.test.ts | 5 | C | 草稿收件人夹具换 example 域 |
| server/wemail/channels/ChannelWorkerEdgeCases.test.ts | 3 | C | 渠道回执中的邮箱夹具换 example 域 |
| server/wemail/database/MailDatabaseQueryRepository.test.ts | 14 | C | 账号/联系人邮箱夹具换 example 域 |
| server/wemail/directory/DirectoryRepository.test.ts | 67 | C | 拆分：服务层用例随 P2 通讯录抽离迁出，存储层用例的企业域名/组织树夹具整体换 example 域（全库最大单点） |
| server/wemail/intelligence/processors/LinkExtractionProcessor.test.ts | 6 | C | 链接/邮箱夹具换 example 域 |
| server/wemail/mail/ImapSmtpMailProvider.test.ts | 8 | C | 收件人夹具换 example 域 |
| server/wemail/mail/MailCredentialError.test.ts | 1 | C | 测试名中的企业邮箱改中性表述（响应串夹具本身已是通用文案） |
| server/wemail/mail/RemoteImageProxy.test.ts | 1 | C | 可信主机夹具由私网地址换文档保留地址 |
| server/wemail/mail/normalizeMail.test.ts | 4 | C | 日历/邮件夹具中的邮箱换 example 域 |
| server/wemail/mcp/McpExtendedDispatch.test.ts | 3 | C | 联系人/发件人夹具换 example 域 |
| tests/browser/01-login.spec.ts | 1 | C | 登录标题断言改为开源版提供商选择流程的中性标题 |
| tests/scripts/package-windows-self-signed.test.mjs | 2 | C | 断言中的下载地址随 D 类外置后换示例地址 |

## D 类明细（5 文件 / 7 处）

| 文件 | 计数 | 类别 | 处置动作 |
| --- | --- | --- | --- |
| electron/main/update-network.ts | 1 | D | 更新源主机白名单中硬编码的内部地址改为 edition/env 注入，开源默认空 |
| electron/main/update-policy.ts | 1 | D | 同上 |
| scripts/package-windows-self-signed.mjs | 2 | D | 打包脚本的默认/回退下载地址改为 env 必填，开源位不留默认值 |
| scripts/update-release-config.ts | 1 | D | 发布配置中的内部地址白名单外置到 overlay |
| server/wemail/mail/RemoteImageProxy.ts | 2 | D | 企业可信图片域后缀列表改为 edition 配置，开源默认空列表 |

## E 类明细（14 文件 / 40 处）

| 文件 | 计数 | 类别 | 处置动作 |
| --- | --- | --- | --- |
| docs/prompt-eval-rig-status.html | 1 | E | 一次性内部评测产物（含本机路径），直接删除 |
| docs/superpowers/plans/2026-07-26-linear-github-team-workflow.md | 5 | E | 内网代码托管迁移操作记录（含内部服务器地址），直接删除 |
| docs/todos/ 下的邮件同步验收清单（文件名含组织名） | 4 | E | 面向生产邮箱的内部验收清单，直接删除 |
| services/wemail-support/evals/conversation-cases.json | 1 | E | 内部支持机器人评测集，整体随内部支持服务迁出或删除 |
| services/wemail-support/evals/golden-cases.json | 5 | E | 同上（用例 id 与预期文档引用含组织名） |
| services/wemail-support/evals/module-score-wm01-wm05.md | 5 | E | 内部支持质量评分记录，删除 |
| services/wemail-support/evals/module-score-wm12-wm17.md | 3 | E | 同上 |
| services/wemail-support/evals/real-experience-review-2026-08-13.md | 2 | E | 内部走查记录，删除 |
| services/wemail-support/facts/current-release.json | 2 | E | 内部支持事实库（引用内网入口与内部源码路径），删除 |
| services/wemail-support/knowledge-seed/ 产品术语文档 | 1 | E | 内部支持知识库整体迁往闭源仓（或删除） |
| services/wemail-support/knowledge-seed/ 邮箱连接指南 | 2 | E | 同上 |
| services/wemail-support/knowledge-seed/ 企业邮箱认证文档（文件名含组织名） | 6 | E | 同上 |
| services/wemail-support/knowledge-seed/ 通讯录与收件人文档 | 1 | E | 同上 |
| services/wemail-support/knowledge-seed/ WeCLI/MCP 指南 | 2 | E | 同上 |

## F 类明细（1 文件 / 1 处）

| 文件 | 计数 | 类别 | 处置动作 |
| --- | --- | --- | --- |
| website/package-lock.json | 1 | F | 误报：依赖完整性哈希的 base64 中随机子串恰与内网 registry 名撞词。正确处置是让门禁按 basename 跳过嵌套路径下的锁文件（现有跳过名单只匹配仓库根级裸文件名），而不是改锁文件内容；需人工确认门禁改法并同步收缩基线 |

## 附注：门禁结构性风险（提交前必须处理）

1. **门禁三件套目前均为 git 未跟踪状态**（检查脚本、基线 JSON、two-repo-edition-split 变更目录），因此暂不被扫描。但其中：检查脚本的规则定义、基线 JSON 的键名（含带组织名的文件路径）、本变更 tasks/design 中约 4 处企业版行为叙述，都内含命中原文。这些文件提交前必须：（a）让门禁按 basename 排除自身与基线文件；（b）先把本变更目录文档消毒为占位表述。否则一提交门禁即失败。
2. **F 类锁文件误报**同源：跳过名单按完整相对路径匹配，未覆盖嵌套目录下的锁文件；改为按 basename 判断即可，锁文件内容不动。
3. 已被 .gitignore 的运行数据目录（如 control-plane 的审计日志）中存在含私网地址的消息样例，不在基线范围内；保持忽略状态、不要提交即可。
4. 执行 E 类删除与 A/B/C/D 修改后，应运行 `node scripts/check-public-boundary.mjs --update-baseline` 收缩基线并逐条审查 diff，保持棘轮只降不升。

生成日期：2026-11-11。基线口径：103 文件 / 356 处（门禁当前输出 passed）。
