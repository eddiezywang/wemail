# AI Semantic Search QA

## Problem

Users need to find mail and ask cross-mail questions in natural language. The first version should be locally useful, account-isolated, cited, and resilient when embedding providers are unavailable.

## Proposal

Add a semantic index table for email chunks with embeddings or lexical fallback. Support incremental indexing, semantic search route, and mail QA through agent/tool API returning answer plus citations. If evidence is insufficient, answer that nothing was found.

## Scope

In scope: index storage, incremental update, lexical fallback, search route, QA route/tool, fixtures/eval, account isolation.

Out of scope: large-scale cloud vector search and uncited free-form inbox analysis.
