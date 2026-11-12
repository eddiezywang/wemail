# AI Summary Thread Quality - Design

## Architecture

Keep the current single-mail summary route compatible while extending the processor/service interface with `mode: "email" | "thread"`. Thread mode builds ordered context from oldest to newest and compresses long history into bounded sections with source ids.

## Output Contract

Summary output:

```ts
{
  bullets: string[];
  actionItems: Array<{ text: string; owner?: string; deadline?: string; evidenceRefs: string[] }>;
  urgency: "low" | "normal" | "high";
  risks?: string[];
  openQuestions?: string[];
  evidenceRefs: string[];
}
```

## Failure and Retry

Retry must update or reuse the existing failed job/result for the same email/thread, mode, and processor version. It must not create duplicate successful results.

## Handoff

Change ID: `ai-summary-thread-quality`
Goal: high-quality evidence-backed summaries for mail and threads.
