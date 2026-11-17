# AI Writing Suite

## Problem

Reply draft and new compose generation need a unified, safe writing surface. Drafts must be editable, style-aware, context-aware, and never sent automatically.

## Proposal

Unify reply and compose writing around explicit draft creation. Reply drafts consume summary, reply decision, mail context, writing style, and user profile. Compose supports intent, optional pre-send recipients, style, and target language. Missing writing purpose or unsafe factual ambiguity returns `needsClarification`; recipients may stay empty until send time. Saved AI compose drafts remain visible and editable through the normal Drafts folder. Draft feedback records accepted, deleted, edited-and-sent, and regenerated states.

## Scope

In scope: writing contracts, reply and compose processors/routes, versioned draft persistence, clarification handling, feedback events, fixtures/eval.

Out of scope: automatic sending and full rich-text editor redesign.
