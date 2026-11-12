## Context

WeMail is an Electron-only, local-first desktop application. The existing change already provides channel profiles, owner pairing, account/conversation bindings, inbound and outbound ledgers, automation integration, diagnostics, and renderer surfaces, but its transport assumes a separately operated LangBot server. That conflicts with the product requirement that a customer installs and starts only WeMail.

Qwen Code Channels provides maintained TypeScript adapters built on the official Feishu and WeCom SDKs. WeMail will use the adapters as protocol libraries, not Qwen’s agent runtime.

## Goals

- One installer, one visible application, no externally managed gateway.
- A crash-isolated Bot Core process supervised by Electron main.
- One Feishu and one WeCom configuration in MVP.
- Direct messages converse with WeMail; groups require an explicit mention.
- One logical owner with a separately verified platform identity per bot.
- Durable, retryable replies and automation sends without rerunning agent or automation work.
- Immediate rendering of cached status followed by one silent startup detection.

## Non-Goals

- Running LangBot, Qwen Code CLI, or a cloud WeMail gateway.
- Supporting every Qwen channel adapter.
- Making the renderer or local Hono API hold plaintext bot credentials.
- Claiming channel availability after the desktop application explicitly exits.
- Streaming cards, voice, or arbitrary attachment downloads in MVP.

## Decisions

### Bot Core is an invisible Electron utility process

Electron main supervises a `utilityProcess` named `WeMail Bot Core`. It owns the Qwen Feishu and WeCom adapter instances, long connections, reconnect behavior, and outbound SDK calls. It has no `BrowserWindow`. Hiding WeMail to the tray does not stop it; explicit application Quit performs a graceful shutdown and then terminates it if necessary.

The supervisor uses protocol-version negotiation, ready/heartbeat messages, request IDs, bounded request timeouts, exponential restart backoff, and automatic configuration replay after restart. A Bot Core crash does not terminate Electron main or corrupt the renderer.

### Qwen adapters are transport libraries

WeMail subclasses `FeishuChannel` and `WeComChannel` at the adapter boundary and overrides their protected inbound hook. The hook converts Qwen’s `Envelope` to a provider-neutral WeMail envelope and sends it to Electron main. Qwen’s ACP/agent bridge is not used to run prompts; the existing WeMail `AgentRuntime` remains authoritative.

Outbound operations use the adapter’s public send API. Provider errors are classified into retryable, ambiguous, and permanent failures before they reach the existing delivery ledger.

### Secrets cross only the private process channel

The renderer submits credentials to the authenticated loopback API. Electron’s `safeStorage` implementation stores each secret under a namespaced reference. SQLite contains only non-secret configuration, secret references, status, and audit metadata.

Electron main resolves secrets immediately before configuring Bot Core and transmits them only over the transferred `MessagePort`. Secrets are excluded from command-line arguments, environment variables, logs, diagnostics, API responses, and crash metadata.

### Inbound messages enter the existing durable pipeline

Bot Core emits normalized messages containing platform, bot/profile key, sender, chat, message ID, group/mention flags, text, and bounded attachment metadata. Electron main forwards them directly to the server channel runtime; no public or loopback webhook is required.

The runtime performs pairing-command interception, deduplication, access and mention policy, binding resolution, `AgentRuntime` execution, safe response projection, and durable outbound queueing. Direct conversations are scoped per platform/bot/sender. Group conversations default to group-plus-sender isolation.

The shared PI mail-assistant prompt remains authoritative. For trusted Feishu or WeCom provenance, the runtime dynamically appends a channel response policy: match the user's language, prefer short plain-text chat replies, preserve confirmation rules, and avoid internal details. Group turns receive an additional hard privacy instruction that prohibits mailbox-specific disclosure and redirects those requests to direct chat.

Accepted channel turns and their sanitized final assistant text are stored in the binding's existing agent conversation. Later turns receive the last eight non-empty messages, capped at 1,200 characters each, so references such as “继续” and “刚才那封” work without an independent bot memory system. Platform event IDs are stored with both sides of the turn so a recovered lease can reuse a completed assistant result without duplicating history or rerunning the agent.

### Owner pairing proves control

WeMail displays a short-lived, single-use pairing code. The intended owner sends `/wemail connect <code>` in a direct chat with the configured bot. Matching platform, bot, and code establishes the platform owner identity. Because the current product is a single-mailbox tenant, the same local transaction binds that owner to the active WeMail mailbox. Re-pairing revokes the former owner's channel bindings, binds the replacement owner to the current mailbox, and increments the owner binding version.

After pairing, WeMail queues one idempotent initialization message. The profile becomes ready only after confirmed delivery. Detection is read-only; “发送测试消息” is an explicit separate action.

### Configuration UX is platform-first

The “连接” settings section always lists WeCLI, 飞书, and 企业微信. Selecting an unconfigured platform opens a guided vertical flow:

1. create and publish the bot in the vendor console;
2. enter only the platform identifiers and secrets required by the official adapter; WeMail assigns the single platform bot a fixed label and uses the SDK's default connection endpoint;
3. save and detect the long connection;
4. pair the owner by direct message and automatically bind that verified owner to the active single mailbox;
5. confirm initialization and enter the operational view.

Completed steps are durable and resumable. Operational actions are detection, test message, re-pair owner, and disconnect. The sidebar shows only last-known connected integrations and omits the entire strip when none are connected.

### Status favors non-blocking continuity

The server persists the last completed normalized observation. Renderer startup paints it immediately, then triggers one low-priority detection per application session. It retains the previous result while detection is in flight and updates the shared cache only when authoritative state or visible metadata changes. There is no interval, focus, or settings-entry polling.

### Automation targets typed destinations

`publishBotMessage` stores a stable bot profile ID, platform, destination type, destination ID, and owner binding version when relevant. MVP destinations are the verified owner DM and eligible conversations already observed through that bot. The UI never presents an arbitrary user ID, chat ID, generic webhook, or a destination from another platform/profile.

Rendered content is frozen before enqueue. One initial attempt plus two delayed retries operate only on the delivery row; they do not rerun matching, processors, or agent work. Delivery observations update the same integration status cache.

## Risks and Mitigations

- **Adapter API drift** — exact-pin all three Qwen packages, isolate imports in Bot Core, and upgrade only through WeMail releases with contract tests.
- **Native SDK/session failure** — supervise with heartbeat and restart/backoff; replay configuration after restart.
- **Secret leakage** — safeStorage plus private IPC only; redact all error and diagnostic payloads.
- **Duplicate inbound/outbound work** — use platform message IDs and existing ledgers; report ambiguous sends honestly.
- **Group data leakage** — owner verification, mention gating, sender isolation, allowlists for non-owner identities, and existing confirmation policy.
- **Channel context leakage or prompt drift** — append one provider-neutral policy only for validated Feishu/WeCom provenance, cap recent history, and impose a stricter group privacy overlay.
- **Desktop not running** — state clearly that bots run while WeMail is open or hidden to tray, not after explicit Quit.

## Migration Plan

1. Keep existing generic profiles, owners, bindings, ledgers, automation actions, and status observations.
2. Add generic/local runtime contracts and migrate or supersede LangBot-named connection fields without copying secrets.
3. Add Bot Core, supervisor, and server transport seam behind the channel feature flag.
4. Replace LangBot setup fields and webhook usage with direct Feishu/WeCom adapter configuration.
5. Validate the complete pairing, initialization, conversation, group mention, test, and automation flows on both platforms.
6. Remove legacy LangBot routes, client, documentation, and secrets after migration tests pass.

## Resolved Product Choices

- Runtime: local invisible utility process.
- Process visibility: no second window; a second process is acceptable.
- Supported profiles: one per platform in MVP.
- Owner: one logical owner, verified independently per platform.
- Mailbox authorization: successful owner pairing automatically binds the active mailbox in the single-mailbox product.
- Status refresh: cached immediately, one silent startup detection, no polling.
- Automation: owner and observed eligible conversations.
- Dependency policy: exact pins and WeMail-controlled upgrades.
