# WeMail 支持评测集

评测集使用真实用户问题和每个领域最容易误答的场景，检查检索、事实、操作、建单和安全边界。

## 文件

- `golden-cases-wm01-wm05.json`：桌面运行、认证、同步、发信和通讯录。
- `golden-cases-wm06-wm11.json`：摘要、标签、待办、问答、写作和个人助理。
- `golden-cases-wm12-wm17.json`：自动化、洞察、MCP/Skill、Bot、模型配置和诊断隐私。
- `response-rubric.md`：回复质量的六维评分标准。
- `knowledge-document-rubric.md`：知识文档事实、覆盖、入口、诊断、边界、安全、待办和措辞的八维评分标准。
- `module-score-wm06-wm11.md`：每篇文档的优化前/后评分、扣分证据、修订和剩余风险。
- `module-score-summary.md`：17 个模块的聚合分数和整体完成审计。
- `run-evals.py`：可执行的确定性验收，检查元数据、JSON 重复键、检索命中、案例去重、证据续接和草稿可审阅性。

运行确定性验收：

```powershell
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" .\services\wemail-support\evals\run-evals.py
```

该命令不冒充企微端到端验收。真实图片理解、原生流式和单消息只回复一次，必须继续用真实企微消息完成通道验收。

## 每条用例的最低要求

1. 先检索并读取 `expected_document`，不能只凭模型常识。
2. 回复必须包含 `must_include` 的事实语义，不要强求机械的逐字匹配。
3. 回复不得出现 `must_not_include` 中的错误归因、过度承诺或敏感信息索取。
4. `expected_action` 要在实际工具调用中发生；不得用回复文字伪造建单、待办、发送或修复成功。
5. 建单用例必须校验数据库中只存在一个开放案例和一个支持待办；普通回复不得展示内部编号。只有明确从群聊转私聊传递材料的用例，才校验回复中的真实 `case_id`，且不得展示 `todo_id`。
6. 多轮用例必须校验不重复询问已提供信息、不重复建单、不重新从第一步开始排查，并把补充证据追加到原案例。
7. 图片用例必须把真实图片交给消息链路，不得只用 `attachment_description` 代替视觉输入；图片读取失败必须明确说明，读取成功必须引用当次图片中的可见事实。
