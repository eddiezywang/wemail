# AI Priority Reply Decision - Design

## Result Contract

```ts
{
  priorityScore: number;
  level: "low" | "normal" | "high";
  reason: string;
  replyRequired: boolean;
  deadline?: string;
  signals: Array<{ name: string; value: string; weight?: number }>;
}
```

## Determinism

For identical stored mail inputs, profile settings, and prompt version, the result should be reproducible. Rule-derived signals should be computed before model invocation and stored in metadata for explainability.

## Draft Boundary

This change never generates drafts. It may expose `replyRequired=true`; draft creation remains a separate explicit job/tool.
