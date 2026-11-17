# Tag Confidence Tiers

## Capability

Extend `TagProcessor` to output a confidence tier per tag, enabling the frontend to distinguish auto-applied tags from suggested tags.

## Tier Derivation

After the LLM returns tag suggestions and feedback rules are applied:

```typescript
function deriveTier(tag: TagSuggestion): "auto" | "suggested" {
  // Built-in tags with high confidence → auto
  if (BUILTIN_TAGS.includes(tag.name) && tag.confidence >= 0.85) return "auto";
  // Built-in tags with lower confidence → suggested
  if (BUILTIN_TAGS.includes(tag.name) && tag.confidence < 0.85) return "suggested";
  // Non-built-in tags are always suggested
  return "suggested";
}
```

Threshold: `0.85`. This is a phase-one constant, not user-configurable.

## TagResult Update

```typescript
interface TagSuggestion {
  name: string;
  confidence: number;
  source: "system" | "ai";
  tier: "auto" | "suggested";  // NEW
}
```

## Feedback Interactions

| User Action | Effect |
|------------|--------|
| Remove auto-tier tag | Creates reject rule → affects similar mail. Tag removed from this email. |
| Remove suggested tag | Creates reject rule → affects similar mail. Tag removed from this email. |
| Confirm suggested tag | Tag promoted to auto-tier for this email only. No learning. Recorded in feedback. |
| Manually add tag | Tag added to this email. No AI influence. Recorded in feedback. |

Confirm and manual-add actions are recorded in `mail_tag_feedback_rules` with `action='promote'` but the `applyRules()` method does not use promote rules in phase one. The data is collected for future learning.

## API Changes

`POST /api/intelligence/messages/:id/tags/:tag/confirm` — new endpoint. Marks the tag as confirmed (auto-tier) for this email. Records a promote rule.

Existing reject endpoint unchanged.

## Frontend Rendering

- Auto-tier tags: rendered as normal tag chips, same style as user-applied tags
- Suggested-tier tags: rendered with a distinct visual treatment — lighter border, "AI suggested" indicator, confirm (✓) and dismiss (✗) actions
- When a suggested tag is confirmed, it transitions to auto-tier visual style
