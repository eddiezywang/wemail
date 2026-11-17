# AI Translation Quality - Tasks

## Implementation

- [ ] Write failing tests for paragraph order and mapping preservation.
- [ ] Write failing cache tests proving the same email/language/version avoids a second LLM call.
- [ ] Write failing tests for target language from request and profile fallback.
- [ ] Write failing tests that URLs, email addresses, code blocks, and tracking ids remain unchanged.
- [ ] Write failing long-mail tests for segmented translation without token-limit failure.
- [ ] Implement translation result contract and cache repository/service.
- [ ] Implement segmentation and recombination.
- [ ] Implement protected-token masking/restoration.
- [ ] Add at least 20 translation fixtures and eval thresholds.
- [ ] Run focused translation processor, cache, route, and eval tests.
- [ ] Run `npm run typecheck:server`.
- [ ] Run `npm run test:server`.
- [ ] If translation UI/API cache status is touched in frontend, run relevant client typecheck.

## Execution Agent Report

```text
Change ID: ai-translation-quality
Goal:
Files touched:
Spec scenarios implemented:
Tests added:
Verification commands:
Known gaps:
Risk notes:
Ready for review: yes/no
```

## Merge Gate

Block merge if repeated requests burn LLM calls, URLs/emails are corrupted, or long mail is silently truncated without signaling.
