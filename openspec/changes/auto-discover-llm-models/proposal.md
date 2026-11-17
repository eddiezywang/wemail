# Auto-discover LLM Models

## Problem

WeMail currently requires users to know and type a default model id while configuring an LLM endpoint. The settings and onboarding forms use a static hint list, even though OpenAI-compatible and Anthropic endpoints can expose the models available to the supplied credentials.

## Proposal

Add a side-effect-free model discovery endpoint and a shared searchable model picker. After a user supplies a Base URL and API key, WeMail discovers model ids, preserves an existing selection when possible, and lets the user manually enter an id when discovery is unsupported or fails. Discovery metadata remains factual: model ids, provider protocol, ownership when returned, and selection state only.

## Scope

In scope: OpenAI-compatible and Anthropic model listing, endpoint/protocol normalization, stored-key reuse in settings, onboarding discovery, searchable/custom model selection, loading/error/empty states, focused backend and frontend tests.

Out of scope: model quality recommendations, pricing/capability inference, native provider protocols beyond the two already supported by WeMail, and persistent model-catalog synchronization.

## Success Criteria

- A user can configure WeMail without manually researching a model id when the endpoint supports model listing.
- Discovery failure never prevents manual model-id entry.
- Discovery does not save settings or send a generation request.
- The UI never labels a model as faster, cheaper, higher quality, recommended, or tool-capable without authoritative metadata.
- Existing settings retain their selected model when it is absent from a refreshed list.
