# WeMail Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

WeMail serves people who manage work email in a Windows Electron desktop application and need to understand, classify, and act on messages without repeatedly maintaining manual rules.

## Product Purpose

WeMail combines a local mailbox experience with AI-assisted summaries, classifications, actions, and reusable smart tags. Success means a user can understand an incoming message quickly and turn useful recurring patterns into durable organization rules they control.

## Positioning

Mail intelligence is stored as inspectable product data, while user-confirmed smart tags remain editable rules. AI-discovered content topics are candidates, not automatic permanent taxonomy: a user reviews and promotes them before they affect historical organization.

## Operating Context

The product runs as an Electron desktop application. Mail analysis may produce built-in classifications, configured smart-tag matches, and bounded inline content topics. Users review message intelligence in the email detail panel and manage formal smart tags in the sidebar and smart-tag surfaces.

## Capabilities and Constraints

- Electron is the only supported desktop runtime.
- Built-in classifications, configured smart tags, and AI content-topic candidates have distinct semantics.
- Every saved `contentTags` item is eligible for explicit user promotion into a formal smart tag.
- Promotion drafts use only the current email and remove sample-specific details when forming a reusable rule.
- Candidate promotion reuses the standard smart-tag creation flow: users review the prefilled name and generated description, then the shared compiler produces the classification prompt.
- Formal smart tags are unique by normalized name per account and trigger asynchronous historical backfill.
- Mail bodies, raw model responses, and internal reasoning must not be exposed in renderer responses or logs.

## Product Principles

- Keep AI suggestions reversible and user-controlled.
- Turn one-message insight into a reusable rule only after review.
- Preserve clear semantic boundaries between system classification, AI candidates, and user-owned taxonomy.
- Prefer graceful, editable fallbacks when model generation is unavailable.
- Treat local mail content as sensitive throughout inference, persistence, and diagnostics.

## Accessibility & Inclusion

All candidate-promotion actions must be keyboard operable, expose descriptive accessible names, retain visible focus, and communicate loading, fallback, validation, conflict, and completion states without relying on color alone.
