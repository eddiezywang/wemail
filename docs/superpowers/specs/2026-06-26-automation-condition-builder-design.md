# Automation Condition Builder Design

## Goal

Replace the fixed structured-condition form with a flexible condition builder. Natural language remains the primary rule condition. Structured conditions become optional condition rules made from editable rows.

## User Experience

The condition rule builder is hidden by default. When expanded, it shows:

- A match mode control: `全部满足` or `任一满足`.
- A list of condition rows.
- An `添加规则` action.

Each row has:

- Field: sender, recipient, cc, subject, body, attachment, or AI tag.
- Operator: contains, does not contain, equals, does not equal, exists, or does not exist.
- Value: text input when the operator needs a value; no value input for exists-style operators.
- Delete action.

Examples:

- `全部满足`: sender contains `github.com`, subject does not contain `unsubscribe`.
- `任一满足`: sender contains `boss@example.com`, AI tag equals `客户`.
- Attachment exists or does not exist uses no free-text value.

## Data Model

Keep the current `conditions` object for backward compatibility. Add a new structured rule model:

```ts
type AutomationConditionMode = "all" | "any";

interface AutomationConditionRule {
  id: string;
  field:
    | "sender"
    | "recipient"
    | "cc"
    | "subject"
    | "body"
    | "hasAttachment"
    | "aiTag";
  operator:
    | "contains"
    | "notContains"
    | "equals"
    | "notEquals"
    | "exists"
    | "notExists";
  value?: string | boolean;
}
```

`AutomationRule` gets optional `conditionMode` and `conditionRules` fields. New rules should submit `conditionRules`; legacy rules may still contain only `conditions`.

## Matching Semantics

If `conditionRules` is present and non-empty, the backend evaluates those rows. If it is absent or empty, the backend falls back to legacy `conditions`.

For `conditionMode`:

- `all`: every row must match.
- `any`: at least one row must match.

Negative operators are row-level negation:

- `notContains`: field text must not contain the value.
- `notEquals`: field text must not equal the value.
- `notExists`: the field must be empty, absent, or false depending on field type.

Structured conditions and natural-language conditions are both filters. If both are present, a message must pass the structured filter and the natural-language evaluator.

## API and Compatibility

Create and update endpoints accept `conditionMode` and `conditionRules`. Validation rejects automatic rules that have neither natural-language condition nor any structured condition, considering both legacy `conditions` and new `conditionRules`.

The repository stores the new fields in JSON columns. Existing rows remain readable. Older `conditions` data is not migrated immediately; it is converted only for display convenience in the form or matched through the fallback path.

## Tests

Add focused tests for:

- Matching all rows.
- Matching any row.
- Negative operators.
- Exists and not-exists operators.
- Fallback to legacy `conditions`.
- API validation with natural-language-only, condition-rules-only, and empty automatic rules.
