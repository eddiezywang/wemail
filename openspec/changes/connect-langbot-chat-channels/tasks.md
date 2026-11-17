## 1. Re-baseline and Dependencies

- [x] 1.1 Replace the separately deployed LangBot architecture with an invisible local Bot Core design using Qwen Code Channels
- [x] 1.2 Record the accepted owner, lifecycle, status-refresh, platform, access, retry, secret, and automation destination decisions
- [x] 1.3 Exact-pin `@qwen-code/channel-base`, `@qwen-code/channel-feishu`, and `@qwen-code/channel-wecom` at `0.21.1`
- [x] 1.4 Replace the LangBot gateway capability spec and remaining LangBot terminology in affected capability specs

## 2. Preserve Generic Channel Foundations

- [x] 2.1 Preserve bot profiles, owner identities/history, hashed pairing challenges, bindings, inbound ledger, outbound ledger, initialization versions, and audit records
- [x] 2.2 Preserve binding isolation, deduplication, leases, bounded retries, safe response rendering, approval references, and account authorization
- [x] 2.3 Preserve normalized integration observations, non-blocking cached display, connected-only sidebar projection, and one silent startup refresh
- [x] 2.4 Preserve the canonical `publishBotMessage` automation action and delivery-ledger execution path

## 3. Generic Connection Model and Secrets

- [x] 3.1 Add provider-neutral Feishu/WeCom connection contracts and migrations without persisting plaintext credentials
- [x] 3.2 Add namespaced safeStorage keys for Feishu and WeCom adapter secrets and remove LangBot API/webhook requirements from active setup
- [x] 3.3 Adapt connection/profile repositories and management APIs to the one-profile-per-platform MVP
- [x] 3.4 Add tests proving API/database/log responses redact platform secrets

## 4. Bot Core Process and Protocol

- [x] 4.1 Add a versioned Bot Core MessagePort protocol for bootstrap, configuration, inbound messages, sends, probes, status, heartbeat, and shutdown
- [x] 4.2 Implement Qwen Feishu and WeCom adapter wrappers that emit provider-neutral inbound envelopes without invoking Qwen’s agent bridge
- [x] 4.3 Implement the invisible Bot Core utility-process entry with configure/reconfigure, proactive send, probe, reconnect, and graceful disconnect
- [x] 4.4 Implement an Electron main supervisor with heartbeat, request timeouts, restart backoff, configuration replay, and graceful shutdown
- [ ] 4.5 Add protocol, adapter, and supervisor tests including crash/restart and secret-redaction cases

## 5. Server Runtime Integration

- [x] 5.1 Add a provider-neutral runtime transport seam and attach the Electron Bot Core supervisor after local API startup
- [x] 5.2 Route Bot Core inbound envelopes into pairing interception or the existing durable inbound ledger without an HTTP webhook
- [x] 5.3 Route worker, initialization, test, reply, and automation sends through Bot Core with retryable/permanent/ambiguous classification
- [x] 5.4 Replay active configurations on startup and after create, update, enable, disable, re-pair, or disconnect mutations
- [x] 5.5 Retire active LangBot webhook/client composition while preserving a safe data migration path

## 6. Guided Configuration and Status

- [x] 6.1 Replace LangBot URL/API-key setup with platform-specific Feishu and WeCom official-console instructions and credential fields
- [x] 6.2 Keep setup resumable through credentials, detection, owner pairing, initialization, and ready
- [x] 6.3 Keep read-only detection separate from explicit test delivery and dynamically update cached observations after authoritative activity
- [x] 6.4 Keep only last-known connected WeCLI/Feishu/WeCom items in the bottom-left strip
- [x] 6.5 Add renderer tests for redaction, resume, mixed connection states, non-blocking refresh, and connected-only filtering

## 7. Ownership, Conversation, and Automation

- [x] 7.1 Validate direct-message owner pairing, one-time initialization, re-pairing, and unlinking on the new inbound runtime
- [x] 7.2 Enforce owner/full access, allowlisted limited access, direct-message conversation, and group mention gating
- [x] 7.3 Discover and persist eligible previously observed conversations as typed automation destinations
- [x] 7.4 Extend automation validation/editor to select the verified owner or an eligible same-profile conversation and keep Feishu/WeCom distinct
- [x] 7.5 Verify three-attempt delivery retention for ten minutes without rerunning automation work
- [x] 7.6 Automatically bind the verified owner to the active single mailbox, backfill existing owners, and remove the redundant mailbox-binding UI
- [x] 7.7 Preauthorize exact email sends and scheduled sends from the verified WeCom owner only after a saved preview and later natural-language confirmation, without creating an application confirmation, while retaining account checks, idempotency, and audit
- [x] 7.7 Append a channel-aware system prompt policy and persist bounded recent conversation context for Bot follow-ups
- [x] 7.8 Add and remove a native Feishu `OnIt` reaction around accepted channel processing without sending a standalone emoji or blocking the underlying task

## 8. Verification and Cleanup

- [x] 8.1 Run server, renderer, desktop typechecks and focused channel/automation/connection tests
- [x] 8.2 Run the desktop production build covering bundled Qwen adapters and the Bot Core entry
- [ ] 8.3 Run the unpacked desktop packaging check after the locally locked `better-sqlite3.node` is released
- [ ] 8.4 Validate a real Feishu bot end to end: detection, pairing, initialization, DM, group mention, test, and automation delivery
- [ ] 8.5 Validate a real WeCom bot end to end: detection, pairing, initialization, DM, group isolation, test, and automation delivery
- [x] 8.6 Replace LangBot documentation with customer-facing local setup, lifecycle, recovery, and security guidance
- [ ] 8.7 Remove obsolete LangBot code and schema names after migration and end-to-end validation
