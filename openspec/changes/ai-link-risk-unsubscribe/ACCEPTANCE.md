# AI Link Risk Unsubscribe - Acceptance Report

## Change ID
ai-link-risk-unsubscribe

## Scenarios

### No Remote Fetch
- **WHEN** link extraction processes a message containing external links
- **THEN** it SHALL parse local content only (bodyHtml, bodyText, headers)
- **AND** it SHALL NOT issue network requests
- **Verification**: LinkExtractionProcessor never imports `http`, `https`, `net`, `fetch`, or any network module. The `handle` method only uses string parsing (regex, `new URL()`) and returns results synchronously. Tests confirm extraction completes without any network I/O for both safe and malicious URLs.

### Explained Risk
- **WHEN** a link has risk signals (display-domain mismatch, suspicious domain, shortener, unsafe scheme, credential-bearing query, suspicious TLD, deeply nested subdomain)
- **THEN** risk reasons SHALL include a machine-readable code explaining each detected signal
- **Verification**: Each risky link in `LinkExtractionResult.links` carries a non-empty `riskReasons` array. Safe links have an empty `riskReasons` array. The `computeRiskSignals` function is exported and unit-tested for each signal type.

### Unsubscribe Identification
- **WHEN** a message includes a List-Unsubscribe header or body text/HTML containing unsubscribe keywords
- **THEN** link metadata SHALL include an unsubscribe category entry and `unsubscribeUrl` SHALL be populated
- **Verification**: Tests cover List-Unsubscribe header, HTML body unsubscribe, text body unsubscribe, Chinese keyword (退订), and the case where no unsubscribe is present (`unsubscribeUrl` is null).

### Sensitive URL Log Safety
- **WHEN** link extraction logs metadata or stores results
- **THEN** query values for credential-bearing parameters (token, session_id, apiKey, password, etc.) SHALL be redacted
- **Verification**: `redactUrlForLog` function strips sensitive query values while preserving parameter keys and non-sensitive values. Tests cover token, password, apiKey, session_id, multiple sensitive params, and case-insensitive key matching.

## Merge Gates

### No code opens/requests links
- PASS: LinkExtractionProcessor imports no network modules. It uses only `new URL()` for parsing and regex for extraction. No `fetch`, `http`, `https`, `net`, or `child_process` imports.

### No complete sensitive URLs in logs
- PASS: `redactUrlForLog` redacts all credential-bearing query parameter values (token, apiKey, session_id, password, etc.) with `[REDACTED]` placeholder. Non-sensitive query parameters are preserved. The `CREDENTIAL_QUERY_KEYS` set covers 22 sensitive parameter names.

### Not all links high risk
- PASS: Risk scoring is calibrated so that normal HTTPS links with common TLDs and no credential-bearing query parameters are marked `risk: false`. The risk calibration test verifies that a set of 5 normal links (GitHub, Python docs, shopping, HN, Wikipedia) are all safe, while a mix of safe and risky links provides useful discrimination.

## Files Touched
- `shared/wemail/intelligence.ts` -- Extended `LinkExtractionResult` with `riskReasons` array and `payment` category
- `server/wemail/intelligence/processors/LinkExtractionProcessor.ts` -- Enhanced risk scoring with 7 risk signals, unsubscribe detection, `redactUrlForLog`, exported `computeRiskSignals`
- `server/wemail/intelligence/processors/LinkExtractionProcessor.test.ts` -- 52 tests covering extraction, risk signals, log safety, eval fixtures
- `server/wemail/intelligence/IntelligenceService.ts` -- Added `getUnsubscribeUrl` and `getRiskyLinks` methods
- `server/wemail/db/migrations.ts` -- Added migration 17 for link risk columns

## Tests Added
- 52 total tests in LinkExtractionProcessor.test.ts
  - 5 basic extraction tests
  - 2 no-remote-fetch guarantee tests
  - 3 display-domain mismatch tests
  - 2 suspicious domain tests
  - 2 URL shortener tests
  - 2 unsafe scheme tests
  - 2 credential query param tests
  - 2 suspicious TLD tests
  - 2 deeply nested subdomain tests
  - 2 risk calibration tests
  - 5 unsubscribe identification tests
  - 1 payment category test
  - 6 redactUrlForLog tests
  - 2 risk reasons population tests
  - 2 multiple risk signals tests
  - 2 computeRiskSignals unit tests
  - 4 category tests
  - 1 eval suite (25 fixtures)
  - 4 log safety integration tests
  - 1 no-network-modules guarantee test
  - 1 computeRiskSignals synchronous test

## Verification Commands
```bash
npx tsx --test server/wemail/intelligence/processors/LinkExtractionProcessor.test.ts
npx tsc -p server/tsconfig.json --noEmit
```

## Known Gaps
- Plain-text URLs with surrounding Chinese unsubscribe keywords (e.g., "退订请点击 https://...") do not carry the keyword context into the link's actionText, so the category defaults to "navigate" unless the keyword appears in the URL path or the HTML anchor text. This is a fundamental limitation of plain-text link extraction (no surrounding context is captured).

## Risk Notes
- The `SUSPICIOUS_DOMAINS` set is curated manually and may need periodic updates
- The `URL_SHORTENER_DOMAINS` set covers the most common shorteners but is not exhaustive
- The `SUSPICIOUS_TLDS` set may flag legitimate sites on uncommon TLDs; this is a trade-off for phishing protection

## Ready for Review
yes
