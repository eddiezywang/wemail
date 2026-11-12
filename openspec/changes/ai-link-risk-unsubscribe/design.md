# AI Link Risk Unsubscribe - Design

## Extraction

Extract from `bodyHtml`, `bodyText`, and unsubscribe-related headers. Preserve display text and normalized domain, but avoid storing/logging sensitive query values.

## Categories

Categories include `action`, `unsubscribe`, `download`, `payment`, `confirm`, and `navigate`.

## Risk Signals

Risk reasons include display-domain mismatch, suspicious domain, shortener, unsafe scheme, credential-like query parameters, and suspicious TLD. Risk levels should be calibrated so normal links are not all marked high risk.
