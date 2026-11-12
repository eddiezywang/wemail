# AI Todo Extraction Quality

## Problem

Action-item extraction must behave like a usable task system: avoid false positives, avoid duplicates, support confirmation/completion/recovery, and respect user suppression.

## Proposal

Extract suggested todos with title, optional description, due date, start time, confidence, and source span. AI todos start as `suggested`; user confirmation moves them to `confirmed`. Manual and AI todos share one repository. Deduplicate by email/thread, normalized title, and due date.

## Scope

In scope: extraction contract, suggested/confirmed lifecycle, routes for list/complete/restore/delete, dedupe, suppression after delete, fixtures/eval.

Out of scope: calendar sync and multi-user task assignment.
