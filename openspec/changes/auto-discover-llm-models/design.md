# Auto-discover LLM Models - Design

## Architecture

Add `POST /api/settings/llm/discover-models`. A POST body is used so API keys are never placed in a URL. The route accepts `baseUrl`, optional replacement `apiKey`, and optional provider preference. When no replacement key is supplied, the route reuses the locally stored LLM secret.

The server tries the preferred/current protocol first and then the other supported protocol. OpenAI-compatible discovery calls the normalized `/v1/models` or `/models` endpoint with Bearer authentication. Anthropic discovery calls `/v1/models` with `x-api-key` and `anthropic-version`. Responses are normalized and deduplicated to factual entries:

```ts
{
  provider: "openai" | "anthropic";
  models: Array<{ id: string; ownedBy?: string }>;
}
```

Discovery uses a bounded timeout and does not mutate saved settings. The existing save path continues to validate the selected default model with a generation probe.

## Frontend Interaction

A shared `ModelPicker` combines a text input with a popover list. Users may search discovered ids, choose one, or retain/type a custom id. The component exposes only factual states: `已发现`, `当前选择`, and `自定义模型`.

Settings triggers discovery explicitly and may reuse the stored key. Onboarding triggers discovery after credentials are present and also exposes a retry action. A successful single-result discovery selects that id automatically; multiple results keep a valid current selection and otherwise require selection before saving.

## Failure Handling

- Unsupported or missing `/models`: show the upstream-safe error and keep manual input enabled.
- Empty list: show an empty state and keep manual input enabled.
- Changed endpoint/key: clear stale discovery state but do not clear the typed/current model id.
- Existing model absent from results: keep it as a custom current value.
- API key values and upstream response bodies are never logged or returned.

## Handoff

Change ID: `auto-discover-llm-models`
Goal: remove the need to manually research model ids while preserving a reliable manual fallback.
