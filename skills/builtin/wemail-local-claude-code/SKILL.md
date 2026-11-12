---
name: wemail-local-claude-code
description: 当用户要求查看、理解、审查、调试、重构、测试或修改代码时，必须委派给本机 Claude Code CLI；适用于代码仓库、项目文件、Git diff、PR、构建和开发工具链任务。
---

# WeMail 本地 Claude Code 委派

只要请求涉及代码，就使用本机 Claude Code，不要由当前 WeMail Agent 直接代替 Claude Code 阅读或修改仓库。

## WeMail 工具映射

详细编排原则、Claude CLI 参数、JSON 输出、会话恢复、代码审查、并行任务和常见陷阱参见 [Hermes Claude Code 编排指南](references/hermes-claude-code.md)。该文件是 Hermes Agent `claude-code` Skill 的大面积移植，保留其 MIT 归属信息。

Hermes 原文中的 `terminal` / `process` 是 Hermes 工具名；在 WeMail 中分别使用下面的本地 Claude Code 任务工具，不要尝试调用不存在的 Hermes 工具。

- 用 `start_local_claude_code` 启动任务；它使用 Claude Code print mode、`stream-json` 和 `--dangerously-skip-permissions`，立即返回 `taskId`。
- 启动时传入明确的绝对 `cwd`，把用户目标、验收条件和相关上下文写进 `prompt`。
- 用 `wait_local_claude_code_task` 等待最多 20 秒；返回 `running` 或等待超时不代表任务失败，也不要重复启动同一任务。
- 用 `get_local_claude_code_task` 搭配返回的 `nextCursor` 查看增量输出；用 `list_local_claude_code_tasks` 找回当前或重启后恢复的任务。
- 用户明确要求停止，或任务达到硬截止时间时，才使用 `cancel_local_claude_code_task`。
- 记录并复用返回的 `claudeSessionId`，后续迭代用 `resumeSessionId` 或 `continueLatest`，不要把同一任务复制成多个 Claude 会话。

## WeMail 约束

- 第一版使用 print mode；Hermes 指南中的 tmux 交互方案不适用于当前 Windows Electron 运行时。
- 遵守目标仓库中的 `AGENTS.md`、`CLAUDE.md` 和项目约束。测试、类型检查、构建、启动或重启仍须以用户当前请求为准。
- Claude Code 进程由 WeMail 任务服务管理。不要使用 `nohup`、`&`、后台 shell 或自行拼接命令绕过任务注册表。
- 不要读取或改写 Claude Code 的 OAuth 凭据；运行时会保留 `CLAUDE_CODE_OAUTH_TOKEN`，并过滤 WeMail 应用环境变量。
- 任务结束后，根据 Claude 的结构化结果报告状态、会话 ID、修改摘要、失败原因和仍需用户执行的验证命令。
