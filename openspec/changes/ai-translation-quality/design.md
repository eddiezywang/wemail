# AI Translation Quality - Design

## Result Contract

Translation result includes target language, cached flag, paragraph mappings, translated text, and metadata. Paragraph mappings preserve source order and allow future UI side-by-side rendering.

## Cache

Cache key: account id, email id, target language, processor version, and source content hash when available. Same key should not call the LLM again.

## Preservation

Protect URLs, email addresses, code blocks, and tracking ids before translation and restore them unchanged after translation.
