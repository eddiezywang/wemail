# AI Link Risk Unsubscribe

## Problem

Users need to identify important links, unsubscribe links, and risky links without WeMail fetching external URLs or leaking credential-bearing URLs to logs.

## Proposal

Extract URLs from mail body and headers, classify link categories, compute display domain and risk reasons, and expose unsubscribe detection. Never request remote URLs. Sanitize logged URL query values.

## Scope

In scope: body/header link extraction, category/risk classification, unsubscribe detection, fixtures/eval, log-safety tests.

Out of scope: automated unsubscribe requests, remote page scanning, browser opening.
