# AI Personalization Learning - Design

## Profile

Profile fields include important contacts, summary language, reply tone, and signature preference. These are explicit user settings and can be read/reset.

## Learning Summary

Raw feedback is aggregated into bounded per-feature summaries. Prompt builders consume the summary and profile, never raw private feedback text in logs.

## Usage

Usage records include processor version, model, success/failure, token counts, latency, and stable UI bucket. Routes return fixed buckets for UI plus detailed rows for diagnostics.
