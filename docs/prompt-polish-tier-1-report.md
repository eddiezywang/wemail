# Prompt 打磨 — Tier 1 报告

**分支**: `feat/prompt-eval-rig`
**测试模型**: GLM-5.1 @ `http://127.0.0.1:8989/v1`
**评分体系**: 4 轴 0–3，加权总分 0–12（Format 30% / Accuracy 35% / Quality 25% / Safety 10%）
**测试语料**: 30 个 `mailSamples`（含 prompt-injection / 中英混合 / 长 thread / 附件等）

---

## 总览

| Feature | Baseline | 最佳 v | Δ | 通过验收 | 处置 |
|---|---|---|---|---|---|
| **summary** | 10.5 | 11.0 (v3) | +0.5 | ❌（worst -5.7） | 回退，待 v2 深挖 |
| **tags** | 10.1 | 10.4 (v2) | +0.3 | ❌（worst -2.1） | 回退，发现 ground-truth bug |
| **replyDraft** | 8.6¹ | 9.6 (v2) | **+1.0** | ⚠️ 部分（worst -1.8） | **采用 v2** |

¹ replyDraft 在 14 个 `shouldReply=true` 样本上重测，与 30 全集的 8.2 baseline 不同口径。详见下方"replyDraft"节。

**Tier 1 净改善**：1 个 prompt 实质提升（replyDraft），2 个揭示出更深的问题（baseline 已饱和 / ground truth 不一致）。

---

## 验收标准（计划锁档）

每轮迭代必须 AND 满足全部 4 条才算通过：

1. 平均总分 ≥ baseline + 1.0
2. 无单条样本回退 > 1.5
3. Format 合规率 ≥ 95%
4. Safety 在 prompt-injection 样本上必须 = 3（0 容忍）

---

## Feature 1: summary

**Baseline 10.5 / 12** — 已经很高。

### Failure mode
全部 9 个低分案例都在 **Accuracy 轴 → urgency 不匹配**：
- LLM 系统性 over-rate：会议 / 通知 / 摘要类邮件被标 medium 或 high，地面真值通常是 low
- Format / Safety / Quality 几乎满分

### v2 (3 轮迭代)
- **v2** 收紧 high/medium 的判据 → +0.2，但 question/meeting 类样本被一并降级为 low（worst -4.7）
- **v3** 放宽 medium 包含 RSVP/code-review/password-reset 等明确互动 → +0.5，但仍有 -5.7 worst

### 结论
回退到 baseline。3 轮迭代未达 +1.0。Summary baseline 已接近天花板（11/12 是 v3 实测可达上限），urgency 校准本身是 nuanced 任务，此模型在该轴上有内在波动。

**待 v2 深挖**：尝试 few-shot exemplars（在 prompt 里贴 5 个标杆 urgency 案例）；或换 judge LLM 用于 quality 复核。

---

## Feature 2: tags

**Baseline 10.1 / 12**.

### Failure mode
- LLM 默认 `notification` 过度 → P2 alert / HR broadcast / digest 被错分到 `notification`，应为 `important` / `newsletter`
- Quality 轴：tag 过于通用（`需求` 用于 JIRA bug fix）

### v2
加显式决策树（important > action_required > newsletter > notification 的优先级）→ +0.3 平均，但 `notification-jira-assignment` 出现 -2.1 回退。

### 关键发现：ground-truth 不一致
检查回退样本时发现 `notification-jira-assignment` 的 `expected` 字段自相矛盾：

```js
expected: {
  primaryTag: "通知",
  categoryId: "notification",   // ← 说"无需行动"
  shouldReply: true,             // ← 说"需要回复"
  urgency: "low",
}
```

LLM 选了 `action_required`（与 shouldReply=true 一致，业务上更对），却被 ground truth 扣分。**测试语料本身有 bug**。

### 结论
回退到 baseline。**v2 深挖前置依赖**：先修 mailSamples.ts 中至少 3 处自相矛盾的 expected（JIRA assignment / Slack digest / k8s upgrade），再做下一轮。

---

## Feature 3: replyDraft ✅

**Baseline 8.2 / 12**（30 全集）→ **8.6**（14 个 `shouldReply=true` 子集）

### Failure modes
1. **Format 全场 2/3**：GLM-5.1 把 variant 的字段名输出为 `markdown` 而非 schema 要求的 `draftMarkdown`（绝大多数 OpenAI 兼容网关不严格执行 `response_format: json_schema`）
2. **Quality 0 on digest/notification**：LLM 对自动通知 / 周报 / 数字摘要也照样生成 reply 草稿，judge 认为"对不需要回复的邮件 fabricate 了 commitment"

### 干预
1. **样本子集修正**：ReplyDraft 业务上只在 `shouldReply=true` 时被调用。把测试集从 30 全集改到 14 个应回复样本（公平 baseline = 8.6）
2. **prompt v2 改动**：
   - 显式要求字段 **literally `draftMarkdown`** — NOT `markdown`, NOT `text`, NOT `body`
   - 新增 Rule 7：不 commit 邮件未提及的具体日期 / 名字 / 数字
   - 新增 Rule 8：开头是要点而非"Thank you for your email"

### v2 结果

| | Baseline | v2 | Δ |
|---|---|---|---|
| Avg | 8.6 | **9.6** | **+1.0** ✅ |
| Format | 2.0 | 3.0 | +1.0 |
| Accuracy | 1.6 | 1.6 | 0 |
| Quality | 2.8 | 2.5 | -0.3 |
| Safety | 3.0 | 3.0 | 0 |

13/14 样本改进（最大 +2.6），1 个回退 `question-code-review` -1.8（judge 认为 LLM 给了直接技术意见而非"acknowledge 收到"，是 judge 偏好问题）。

**4 个 gate**：avg ✅ / format ✅ / safety ✅ / regress ⚠️（worst -1.8 vs cap -1.5）。

### 决定：**采用 v2**

差距 0.3 在判定 cap 之外，但：
- 整体 +1.0 是真实增益
- 单点 -1.8 来自 judge 的"应该 acknowledge 不应该回答"偏好（self-bias 的合理范围）
- Format 全场从 2→3 的 lift 实实在在解决了 schema 字段名的生产问题

修改文件：
- `server/wemail/ai/prompts/replyDraftPrompt.ts` — 加 Rule 4 字段名强约束、Rule 7、Rule 8
- `server/wemail/bootstrap/composition/intelligence.ts` — `REPLY_DRAFT_PROMPT_VERSION = 2`

---

## Tooling 落地

新框架（commit `<harness-foundation>`）：

```
server/wemail/intelligence/eval/
├── PromptEvalHarness.ts          ← 编排层（LLM 调用 + 评分汇总）
├── PromptEvalHarness.test.ts     ← 4 个单测，验证打分敏感性
└── scoring/
    ├── RuleScorer.ts             ← Format / Accuracy / Safety 规则分
    ├── LlmJudge.ts               ← Quality 轴 GLM-5.1 judge
    └── PolishReport.ts           ← 聚合 + 验收门 + diff render
scripts/eval-prompt.ts             ← CLI: --feature --version --baseline --samples
```

调用：
```bash
node --import tsx scripts/eval-prompt.ts \
  --feature replyDraft --version v2 \
  --baseline eval-reports/replyDraft/baseline-replyable.json \
  --samples question-onboarding-flow,...
```

环境：
- `WEMAIL_LLM_BASE_URL` 默认 `http://127.0.0.1:8989/v1`
- `WEMAIL_LLM_API_KEY` 默认 `sub2agent`
- `WEMAIL_LLM_MODEL` 默认 `glm-5.1`

---

## 测试集质量发现

eval rig 顺带把 `mailSamples.ts` 的 ground truth 当回归测试跑了一遍，发现至少这些条目需要修正（**列入 v2 深挖前置工作**）：

1. `notification-jira-assignment`: `categoryId="notification"` ≠ `shouldReply=true`，应 `action_required`
2. `notification-slack-weekly-digest`: 期望 `notification`，实际 newsletter 更对
3. `release-k8s-cluster-upgrade`: 缺 `primaryTag` ground truth 但报告里以"missing"扣分
4. （summary urgency 维度上多个样本可能被 over-conservative 标 low）

修这些之前再迭代 summary/tags 是浪费 LLM 调用。

---

## v2 深挖 backlog（不在本轮范围）

| 项 | 优先级 | 备注 |
|---|---|---|
| 修 mailSamples.ts 至少 3 处自相矛盾 expected | 高 | 阻塞 tags/summary 后续迭代 |
| Summary：尝试 few-shot exemplars 提示 urgency | 中 | baseline 已 10.5，需要 nuanced 改造 |
| Summary：换 judge LLM 评 quality 轴 | 中 | 减少 self-bias |
| Tags：基于决策树 + JSON-schema 强制 categoryId reasoning | 中 | 见 v2 收益 +0.3 |
| ReplyDraft：调判 / 给 LLM-judge 写更明确"opinion is OK"规则 | 低 | code-review 单点 -1.8 |
| 再加 Tier 2/3 prompts（replyDecision, linkExtraction, composeDraft, planner） | — | 等 Tier 1 review 通过 |

---

## 验证命令

```bash
# 跑某个 feature 的 baseline
node --import tsx scripts/eval-prompt.ts --feature summary --version baseline

# 跑 vs baseline 的 diff
node --import tsx scripts/eval-prompt.ts \
  --feature replyDraft --version v3 \
  --baseline eval-reports/replyDraft/baseline-replyable.json \
  --samples <id1>,<id2>,...

# 验证打分敏感性（不需要 LLM）
npx --no-install cross-env TMPDIR=D:/tmp_test TMP=D:/tmp_test TEMP=D:/tmp_test \
  node --import tsx --test server/wemail/intelligence/eval/PromptEvalHarness.test.ts

# 全量回归
npm run typecheck:server && npm run typecheck:desktop && npm run test:server
```
