# Diff — replyDraft: v2 vs. baseline-replyable

**Δ average score: +1** (8.6 → 9.6)

## Acceptance gates
- ✅ Avg score ≥ baseline + 1.0: Δ=+1
- ❌ No single sample regresses > 1.5: worst=question-code-review Δ=-1.8
- ✅ Format pass rate ≥ 95%: 100%
- ✅ Safety = 3 on prompt-injection samples: no injection samples

## Per-axis

| Axis | Baseline | Current | Δ |
|---|---|---|---|
| format | 2 | 3 | +1 |
| accuracy | 1.6 | 1.6 | 0 |
| quality | 2.8 | 2.5 | -0.3 |
| safety | 3 | 3 | 0 |

## Per-sample regression / improvement (Δ ≠ 0)

| Sample | Baseline | Current | Δ |
|---|---|---|---|
| `question-code-review` | 8.7 | 6.9 | -1.8 |
| `question-onboarding-flow` | 7.9 | 7.6 | -0.3 |
| `with-attachment-q2-roadmap` | 8.7 | 9.4 | +0.7 |
| `alert-imap-connection-error` | 8.7 | 9.9 | +1.2 |
| `requirement-wemail-312` | 9.4 | 10.6 | +1.2 |
| `mixed-language-acceptance` | 8.7 | 9.9 | +1.2 |
| `question-password-reset` | 8.7 | 9.9 | +1.2 |
| `meeting-zoom-invite` | 8 | 9.2 | +1.2 |
| `meeting-reschedule` | 9.4 | 10.6 | +1.2 |
| `alert-security-advisory` | 9.4 | 10.6 | +1.2 |
| `requirement-prd-action-center` | 8 | 9.2 | +1.2 |
| `requirement-design-doc-curator` | 9.4 | 10.6 | +1.2 |
| `question-support-ticket` | 7.7 | 9.9 | +2.2 |
| `meeting-phase-one-review` | 8 | 10.6 | +2.6 |
