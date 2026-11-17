# 状态口径

- `collecting`：仍缺业务信息。
- `resolving_capabilities`：核对当前机器能力。
- `compiling`：生成并验证流水线。
- `reviewing`：等待当前预览的自然语言反馈。
- `awaiting_final_confirmation`：仅等待最终规则授权。
- `committing` / `verifying`：写入及回读验证。
- 阻塞、需输入、部分成功、失败和已验证完成必须与配置任务最终状态一致。
