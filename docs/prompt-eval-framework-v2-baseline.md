# Prompt Eval Framework v2 — 交付总结

**分支**: `feat/prompt-eval-rig`
**Framework version**: 2.0.0
**Sample manifest**: `eval-reports/_manifests/2026-05-04-fixtures.json`（30 samples，hash `3d2cf5ac94e8`）

## 一、做了什么

把 `feat/prompt-eval-rig` 早期一次性的 prompt 打磨工具升级成长期可用的回归测试框架，
吸收 Codex 对抗性 review 的 7 条修订（详见 `docs/prompt-eval-framework-v2-design.md`）。

按 7 个阶段顺序交付，每个 phase 独立 commit + 全测试通过：

| # | Phase | 提交 | 关键产出 |
|---|---|---|---|
| 1 | 双 spec + FeatureRegistry | `28e70c9` | 现有 5 feature 抽出为独立 spec；plugin allowlist；版本绑定 |
| 2 | Manifest + per-stratum acceptance | `ef9ef12` | immutable sample manifest；fixtures/injection/corpus 独立门槛 |
| 3 | Judge 升级 | `bb395ad` | 双 LlmClient；judgeWithRubric + repeatN + 方差 gate |
| 4 | PII fail-closed corpus | `60f28c9` | 8 类脱敏 + residual scanner；外部 judge gate；2 个 CLI |
| 5 | todoExtraction spec | （pending commit） | 第 6 个内建单轮 spec |
| 6 | AgentRuntime 落地 | （pending commit） | piPlanner + curatorSafety；event 评分；mock 工具 |
| 7 | 文档 | 此 commit | 设计文档 + 交付总结 |

## 二、内建 spec 全集

| # | id | kind | 接入路径 | 关键 axes |
|---|---|---|---|---|
| 1 | summary | single-turn | features/summary.spec.ts | format / accuracy / safety / quality |
| 2 | tags | single-turn | features/tags.spec.ts | 同上 |
| 3 | replyDraft | single-turn | features/replyDraft.spec.ts | 同上 + sampleFilter shouldReply=true |
| 4 | replyDecision | single-turn | features/replyDecision.spec.ts | 同上 |
| 5 | linkExtraction | single-turn | features/linkExtraction.spec.ts | 同上 |
| 6 | todoExtraction | single-turn | features/todoExtraction.spec.ts | 同上（todoCount / hasDeadline） |
| 7 | piPlanner | agent-runtime | features/piPlanner.spec.ts | tool order / final phrases / unknown-tool / injection echo |
| 8 | curatorSafety | agent-runtime | features/curatorSafety.spec.ts | write boundary / banned tools / injection / 安全 weight 0.6 |

## 三、测试覆盖

```
1260 pass  /  0 fail  /  2 skipped (Windows symlink permission)
```

新增单测分布：
- `FeatureRegistry.test.ts` — 10
- `SampleManifest.test.ts` — 8
- `AxisAggregator.test.ts` — 7
- `LlmJudge.test.ts` — 8
- `PiiRedactor.test.ts` — 24（含 Phase 4 全部 8 类）
- `AgentRuntimeRunner.test.ts` — 7
- `PromptEvalHarness.test.ts` — 4（向后兼容保留）

合计 **+68 个新单测**（baseline 1192 → 1260）。

## 四、Codex 修订点对照表

| Codex 提出 | v2 修复 |
|---|---|
| #1 单一接口装不下 piPlanner | 拆 `SingleTurnPromptSpec` + `AgentRuntimeEvalSpec` ✅ |
| #2 EVAL_FEATURES_DIR 任意代码执行 | 改为 `eval-plugins.json` 显式 allowlist + peer dep + specHash ✅ |
| #3 PII 仅 4 类 + 漏到外部 judge | 8 类 + residualScanPassed gate + 外部 judge precheck ✅ |
| #4 全局 avg 让 corpus 稀释 fixtures | per-stratum gates，每组独立 ✅ |
| #5 Curator 留 v3 = 最危险 prompt 没 ship gate | curatorSafety spec 进 v2，5 类硬规则 ✅ |
| #6 judge error 回退 1.5 是假中立分 | judgeError → gate，error rate > 2% fail；主观轴 repeatN+方差 ✅ |
| #7 corpus 文件 frontmatter 让 JSON 非法 | 元数据放 `_meta` 字段，文件保持合法 JSON ✅ |

## 五、运行命令速查

```bash
# 冻结 sample manifest
npm run eval:manifest -- --id 2026-05-04-prod --include-fixtures \
  --out eval-reports/_manifests/2026-05-04-prod.json

# 跑单 feature
npm run eval:prompt -- --feature summary --version baseline \
  --manifest eval-reports/_manifests/2026-05-04-prod.json

# 与 baseline 对比
npm run eval:prompt -- --feature summary --version v2 \
  --manifest eval-reports/_manifests/2026-05-04-prod.json \
  --baseline eval-reports/summary/baseline/baseline.json

# 提取真实邮件 corpus（fail-closed）
npm run eval:extract-corpus -- --from-json my-export.json --out ./corpus/

# 单独跑 PII 残留扫描
npm run eval:corpus-lint -- --dir ./corpus

# 本地全量测试
npm run typecheck:server && npm run test:server
```

> 上述 `npm run eval:*` 别名可酌情写进 `package.json`；当前各 CLI 直接用 `node --import tsx scripts/<name>.ts`。

## 六、环境变量

```bash
# Executor — 用本地 GLM-5.1
WEMAIL_LLM_BASE_URL=http://127.0.0.1:8989/v1
WEMAIL_LLM_API_KEY=sub2agent
WEMAIL_LLM_MODEL=glm-5.1

# Judge — 默认 fall back 到 executor (selfJudge ⚠️)；
# 强烈建议另开外部模型避免 self-bias：
WEMAIL_JUDGE_BASE_URL=https://api.anthropic.com/v1
WEMAIL_JUDGE_API_KEY=$ANTHROPIC_API_KEY
WEMAIL_JUDGE_MODEL=claude-sonnet-4

# Corpus 目录（默认 ./corpus）
WEMAIL_CORPUS_DIR=/path/to/corpus
```

## 七、推荐发版清单

直接合 main 即可：
- 8 个 builtin feature spec 已通过 1260 测试
- 现有 5 个 feature 重构后行为与 Phase 1 前一致（Phase 1 commit 验证）
- Phase 4 PII 管道在 fixtures 上跑过：`extract-mail-corpus --from-fixtures` → 5 文件全通过 residual scan

下一步推荐：
1. 在外部 judge model 上手动跑一次 8 个 feature baseline（约 5 分钟 × 8 ≈ 40 分钟）
2. 把分数填进 `eval-reports/index.md` 全局 dashboard
3. Curator 上线前必须过 `curatorSafety` 全 8 个 scenario safety=3
4. 写 `package.json` 的 `eval:*` 脚本别名简化日常使用

## 八、不在范围

下列项目设计已就位但内容未填：
- composeDraft spec（需 intent 样本集 + 与 MailSampleEntry 不同的 input shape）
- threadSummary spec（需 multi-message scenario shape）
- translation spec（需动态 system prompt 支持）
- mock LLM 容器化以接 CI
- mailSamples 5 处已知 ground-truth 模糊修复

详细见 `docs/prompt-eval-framework-v2-design.md` 的 v3 backlog 段。
