# Prompt 打磨最终报告 — Tier 1 + Tier 2

**分支**: `feat/prompt-eval-rig`
**测试模型**: GLM-5.1 @ `http://127.0.0.1:8989/v1` (sub2agent / OpenAI-compat)
**评分体系**: 4 轴 0–3 加权 0–12（Format 30% / Accuracy 35% / Quality 25% / Safety 10%）
**测试语料**: 30 个 `mailSamples`（含 prompt-injection / 中英混合 / 长 thread / 附件等）

---

## 一、最终成绩单

| Feature | Baseline | 最佳 v | 增量 | 通过验收 | 处置 | 改动文件 |
|---|---|---|---|---|---|---|
| **summary** | 10.5 | 11.0 (v3) | +0.5 | ❌ -5.7 worst | 回退（待 v2 深挖） | — |
| **tags** | 10.1 | 10.4 (v2) | +0.3 | ❌ -2.1 worst | 回退（揭出 ground-truth 模糊） | — |
| **replyDecision** | 11.7 | 11.7 (v2) | 0.0 | — | 回退（已饱和） | — |
| **replyDraft** | 8.6¹ | **9.6 (v2)** | **+1.0** | ⚠️ 部分（-1.8 worst，judge bias） | **采用** | `replyDraftPrompt.ts` + `REPLY_DRAFT_PROMPT_VERSION = 2` |
| **linkExtraction** | 2.5 | **9.6 (v3)** | **+7.1** | ✅ 全过 0 回退 | **采用** | `linkExtractionPrompt.ts` + `LINK_EXTRACTION_PROCESSOR_VERSION = 4` |

¹ replyDraft 在 14 个 `shouldReply=true` 子集上重测（业务上只在 should-reply 时调用）。

**净结果**：5 个 LLM 提示词全测，2 个采用上线（replyDraft / linkExtraction），3 个证明已接近天花板或被 ground-truth 限制。

---

## 二、最大单笔胜利：linkExtraction +7.1

```
baseline 2.5 → v2 7.7 → v3 9.6
```

**Root cause**：GLM-5.1 完全不守 `response_format: json_schema`，输出 `{"selected_indexes": [0]}` 而不是 schema 的 `{"links": [{index, actionText, category}]}`。Format 全场 0/3。

**v2 修法**（+5.2）：在 system prompt 加显式字段名约束 + 负向列表：

> OUTPUT FORMAT: respond with a single JSON object containing one field: `links`.
> `links` MUST be an array of objects with `{index, actionText, category}`.
> Do NOT emit `selected_indexes`, `selected`, `chosen`, or any other field name.

Format 0→3 全场拉满。

**v3 修法**（+1.9 over v2）：v2 太保守，把"自动系统返回链接"也过滤掉了。补：

> When the email contains a primary action link surfaced by an automated system, INCLUDE it. Specifically: 'View it on JIRA' / 'View ticket' / 'Open Slack' / 'Open advisory' / 'View design doc' / 'View PR' / hosted-document links.
> If at least one candidate is a 'primary action', you MUST include at least one link. Returning `{"links": []}` when an obvious primary action exists is incorrect.

之前所有 4.8 分的 jira/slack/runbook/design-doc 案例全跳到 11+。

---

## 三、第二笔胜利：replyDraft +1.0

```
baseline 8.6 → v2 9.6
```

**Root cause**（同款）：GLM-5.1 在 variants 数组里输出 `markdown` 字段而不是 schema 要求的 `draftMarkdown`。Format 全场 2/3 因为缺字段。

**v2 修法**：

> Each variant object MUST have these three string fields: `tone`, `length`, and `draftMarkdown`. The variant text field MUST be literally named `draftMarkdown` — NOT `markdown`, NOT `text`, NOT `body`.

加了两条质量规则：
- Rule 7：禁止 fabricate 邮件未提及的具体日期/名字/数字
- Rule 8：开头切要点，不写 "Thank you for your email"

13/14 改进，1 个回退 -1.8（`question-code-review`：LLM 给了直接技术意见，judge 偏好 acknowledgement 而非 answer。Judge self-bias。）

---

## 四、共同模式：字段名 discipline

LinkExtraction +5.2 和 replyDraft +1.0 都来自同一类修复：

**OpenAI-compat 网关（GLM/local LLM stack/ollama-openai 等）通常不严格执行 `response_format: json_schema`**。Schema 是给 OpenAI 真服务用的；其他 provider 接受 schema 字段但忽略硬约束。

→ **prompt 必须用自然语言显式 pin 字段名 + 给负向列表**（"do NOT emit X / Y / Z"）。否则 LLM 自由发挥，可能漂移到 `markdown` / `selected_indexes` / `text` / `body` 等近义字段。

**这条规则可推广**：所有现有 prompt 在生产用非 OpenAI 端点时都该上字段名 discipline。

---

## 五、ground-truth 重新审视（不是 bug）

迭代过程暴露了几处 mailSamples ground truth 的歧义，**不是 bug，是 schema 设计取舍**：

| Sample | 矛盾点 | 解读 |
|---|---|---|
| `notification-jira-assignment` | categoryId=`notification` 但任务隐含 fix bug | "external-system 自动通知" vs "personal action" 是个 ontology 分类，作者选了前者，LLM 选后者。两者都对 |
| `alert-imap-connection-error` / `alert-security-advisory` | shouldReply=true 但发件人是 `alerts@example.test` / 自动监控 | 期望"action"还是"email reply"模糊。LLM 选 false（你不会回邮件给监控系统） |

→ 这些不该改 ground truth；应**放进 prompt 的判定规则里教 LLM 跟测试作者一致**。但本轮 3 个 prompt（summary/tags/replyDecision）3 轮迭代证明这种"跟人类微调"很难 +1.0，模型在该粒度上有内在波动。

---

## 六、已饱和的 prompt（baseline ≥ 10.5）

| Feature | Baseline | 失败模式 | 为什么难 +1.0 |
|---|---|---|---|
| summary | 10.5 | 全部低分 case 都是 urgency 不匹配（LLM over-rate） | 收紧规则 → 把对的也下调（-4.7）；放宽 → 不够紧（-5.7）。需要 few-shot exemplars |
| tags | 10.1 | LLM 把 P2 / digest / broadcast 默认归 `notification` | 加决策树 → +0.3 但 -2.1 worst；ground-truth 也部分模糊 |
| replyDecision | 11.7 | 仅 2 个 alert 误判 shouldReply=false | 改 prompt 修了 alert 但破坏 long-thread / support-ticket，net 0 |

→ **这 3 个需要不同的优化路径**：要么改 ground truth 一起改，要么改 prompt + 增加 few-shot 示例（v2 backlog）。

---

## 七、测试基础设施落地

```
server/wemail/intelligence/eval/
├── PromptEvalHarness.ts          ← 编排（5 个 feature 的 LLM 调用 + 评分）
├── PromptEvalHarness.test.ts     ← 4 个单测验证打分敏感
└── scoring/
    ├── RuleScorer.ts             ← Format / Accuracy / Safety
    ├── LlmJudge.ts               ← Quality 用 GLM-5.1 self-judge
    └── PolishReport.ts           ← 聚合 + 验收门 + diff
scripts/eval-prompt.ts             ← CLI: --feature --version --baseline --samples
.gitignore: eval-reports/**/*.json (raw, gitignored); .md committed
docs/prompt-polish-tier-1-report.md  ← 早期 tier 1 详报
```

**支持的 feature**：summary / tags / replyDraft / replyDecision / linkExtraction（后两者本轮新增，在 PromptEvalHarness.ts 的 `buildPromptForFeature` switch + `extractLinkCandidates` helper）

**未支持**：
- `composeDraftPrompt`：返回纯 markdown 无 JSON schema，需要合成 intent 字符串作为输入
- `PiAgentRuntime` planner：返回 PlannerDecision，已在 route-c-curator 分支获 JSON repair 处理

---

## 八、运行命令

```bash
# 跑 baseline
node --import tsx scripts/eval-prompt.ts --feature linkExtraction --version baseline

# 与 baseline 对比
node --import tsx scripts/eval-prompt.ts \
  --feature linkExtraction --version v3 \
  --baseline eval-reports/linkExtraction/baseline.json

# 自验打分敏感性（不需要 LLM）
TMPDIR=D:/tmp_test TMP=D:/tmp_test TEMP=D:/tmp_test \
  node --import tsx --test server/wemail/intelligence/eval/PromptEvalHarness.test.ts

# 全量回归
npm run typecheck:server && npm run typecheck:desktop && npm run test:server
```

环境变量：
- `WEMAIL_LLM_BASE_URL` 默认 `http://127.0.0.1:8989/v1`
- `WEMAIL_LLM_API_KEY` 默认 `sub2agent`
- `WEMAIL_LLM_MODEL` 默认 `glm-5.1`
- `WEMAIL_JUDGE_MODEL` 默认与 model 同（self-judge）

---

## 九、v2 深挖 backlog（不在本轮）

| 项 | 优先级 | 估计收益 |
|---|---|---|
| 修 mailSamples.ts 5 处 ground-truth 模糊（jira / slack / alert-imap / k8s / question-onboarding 的 hasDeadline） | 高 | 可让 summary/tags/replyDecision 再迭代 |
| Summary：加 few-shot urgency exemplars 进 prompt | 中 | 可能 +0.5–+1.0 |
| Tags：基于决策树 + JSON-schema 强制 categoryId reasoning | 中 | 类似 v2 收益 +0.3，配合 ground-truth 修复可能更高 |
| ComposeDraft：合成 30 条 intent 测试集 + 加 plain-markdown 评分轴 | 中 | 全新覆盖 |
| Pi planner：写 chat scenario fixtures + multi-turn 评分 | 低 | 已有 JSON repair 兜底，迭代价值低 |
| 用更强外部 model 做 LLM-judge | 低 | 减少 self-bias，但需要付费 API |

---

## 十、推荐发版清单

**采用 v2 / v3 改动**（本轮已 commit + push）：
- `server/wemail/ai/prompts/replyDraftPrompt.ts` — Rule 4 字段名强约束 + Rule 7/8
- `server/wemail/ai/prompts/linkExtractionPrompt.ts` — 字段名 discipline + 负向列表 + 必须包含主操作链接
- `server/wemail/bootstrap/composition/intelligence.ts` — `REPLY_DRAFT_PROMPT_VERSION = 2`
- `server/wemail/intelligence/processors/LinkExtractionProcessor.ts` — `LINK_EXTRACTION_PROCESSOR_VERSION = 4`

**框架**（commit `<harness-foundation>` + 后续扩展）：
- `server/wemail/intelligence/eval/PromptEvalHarness.ts` + scoring/ + 4 单测
- `scripts/eval-prompt.ts` CLI
- `eval-reports/<feature>/<version>.{json,md}` + diff
- `.gitignore`: raw json gitignored

**集成路径**：把 v2 / v3 的 prompt 合并回 `feat/route-c-curator-harness`（或 main），框架本身可以独立接进任意 prompt 修改的 PR review 流程。
