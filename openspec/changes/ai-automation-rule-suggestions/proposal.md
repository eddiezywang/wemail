# AI Automation Rule Suggestions

## Problem

AI can help draft automation rules, but suggestions must not silently enable or execute rules. Users need dry-run visibility, audit logs, and explicit confirmation for dangerous actions.

## Proposal

Add `POST /api/automation/rules/suggest` accepting email id, sender, category, or natural-language intent. Return disabled rule drafts. Provide dry-run with matched mail, reasons, and planned actions. Require explicit confirmation for trash/spam/archive and similar dangerous actions when running.

## Scope

In scope: rule suggestion route, rule draft contract, dry-run reasons, audited run, dangerous action confirmation, fixtures/eval.

Out of scope: fully autonomous rule creation and execution.
