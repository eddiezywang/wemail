# AI Translation Quality

## Problem

Mail translation should preserve structure, tone, terminology, URLs, email addresses, code blocks, and tracking ids. Repeated requests should use cache and user language preference.

## Proposal

Add paragraph mapping to translation results, target language from request or profile, cache key by email id/language/processor version, and segmented translation for long mail.

## Scope

In scope: translation contracts, cache, profile target language, segmented long-mail translation, fixtures/eval, no-translate token preservation.

Out of scope: attachment translation and full bilingual editor UI.
