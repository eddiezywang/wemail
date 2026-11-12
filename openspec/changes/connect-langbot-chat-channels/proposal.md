## Why

WeMail is a serverless Electron desktop product. Users need to converse with its agent and receive automation messages in Feishu and WeCom without installing, starting, or operating a second application. The channel runtime therefore needs to ship inside WeMail while remaining isolated from the renderer and Electron main process.

## What Changes

- Embed the pinned Qwen Code Feishu and WeCom channel adapters in an invisible Electron `utilityProcess` named Bot Core.
- Keep vendor credentials in Electron `safeStorage`; pass decrypted credentials to Bot Core only through a private `MessagePort`.
- Normalize inbound direct/group messages into the existing channel ledger, binding, access-control, confirmation, and `AgentRuntime` flow.
- Deliver replies, initialization messages, test messages, and automation output through the selected Feishu or WeCom adapter.
- Add guided platform-specific setup, direct-message owner pairing, one-time initialization, and retained diagnostics.
- Preserve the last completed WeCLI/Feishu/WeCom observations, render them immediately, and perform one silent background detection per application launch.
- Show only integrations whose last completed observation is connected in the client’s bottom-left connected-capabilities strip.
- Support one Feishu bot and one WeCom bot in the MVP; automation can target the verified owner and previously observed eligible conversations.

## Capabilities

### New Capabilities

- `local-bot-channel-runtime`: Bot Core lifecycle, private IPC, Qwen adapter configuration, inbound normalization, outbound delivery, and health.
- `channel-session-binding`: Tenant-safe mapping between external identities/chats and WeMail accounts and conversations.
- `channel-agent-interaction`: Agent execution, replies, duplicate suppression, access control, and confirmation behavior.
- `channel-onboarding-and-ownership`: Guided setup, owner pairing, readiness detection, initialization, and diagnostics.
- `integration-connection-status`: Cached WeCLI, Feishu, and WeCom observations and connected-only sidebar presentation.
- `bot-message-automation`: Typed automation delivery through a selected platform, bot, and eligible destination.

## Impact

- Adds exact runtime dependencies on `@qwen-code/channel-base`, `@qwen-code/channel-feishu`, and `@qwen-code/channel-wecom`.
- Adds an Electron utility process and a versioned internal IPC protocol; no additional window or user-started service is introduced.
- Reuses the current channel persistence, owner, binding, delivery, automation, and UI foundations while replacing LangBot-specific connection and webhook seams.
- Adds platform credential configuration backed by `safeStorage`; credentials are not returned to the renderer, persisted in SQLite, or written to logs.
- Channel availability follows the WeMail application lifecycle: hiding to tray keeps Bot Core running, while explicit Quit stops it.
