## ADDED Requirements

### Requirement: Channel prompts use the existing WeMail agent runtime
The system SHALL invoke the existing `AgentRuntime` with the bound account, persisted conversation, normalized text, and channel provenance instead of running Qwen's agent bridge.

#### Scenario: Authorized text prompt is processed
- **WHEN** an accepted inbound text event matches an enabled binding and access policy
- **THEN** the channel worker invokes `AgentRuntime.run()` with that account and conversation and queues the final assistant text for delivery through the originating platform adapter

#### Scenario: Agent runtime is unavailable
- **WHEN** an authorized event is leased but the agent runtime is not configured
- **THEN** the system marks the attempt failed with a safe user-facing error and does not lose the inbound ledger record

### Requirement: Channel turns use a channel-aware response policy
The system SHALL append a trusted Feishu/WeCom response policy to the existing WeMail agent system prompt without replacing the shared mail safety contract. The policy MUST prefer concise chat-friendly replies in the user's language, preserve confirmation requirements except for the explicitly preauthorized WeCom-owner direct-send case, avoid internal details, and distinguish direct from group privacy.

#### Scenario: Verified owner writes in a direct chat
- **WHEN** the channel worker invokes the agent for a verified owner's direct message
- **THEN** the system prompt states that the active mailbox is authorized and, only for a verified WeCom owner direct chat, requires a saved draft and reviewable preview in one turn before a send or scheduled-send proposal may execute from a later natural-language confirmation turn without another application confirmation

#### Scenario: Verified owner writes in a group
- **WHEN** the channel worker invokes the agent for an allowed mentioned group message
- **THEN** the system prompt forbids disclosure of mail bodies, attachments, private contacts, and mailbox-specific data and directs the user to continue privately

#### Scenario: Ordinary desktop chat runs
- **WHEN** the agent is invoked without supported Feishu or WeCom channel provenance
- **THEN** the channel-specific policy is not appended

### Requirement: Bound channel conversations preserve bounded recent context
The system SHALL persist accepted user turns and safe final assistant text in the binding's existing agent conversation and SHALL inject at most the eight most recent non-empty messages, bounded to 1,200 characters each, into later channel runs.

#### Scenario: User sends a contextual follow-up
- **WHEN** a bound sender writes “继续” or refers to a prior turn through the same scoped channel conversation
- **THEN** the next agent run receives the recent user and assistant messages before processing the follow-up

#### Scenario: Inbound processing is retried after assistant persistence
- **WHEN** the same platform event is leased again after its assistant result was persisted but before outbound enqueue completed
- **THEN** the worker reuses the persisted safe assistant text and does not append duplicate conversation messages or rerun the agent

### Requirement: Inbound execution is idempotent
The system MUST execute a platform message ID at most once per bot profile unless an operator explicitly retries a recorded failed event.

#### Scenario: Platform redelivers an event
- **WHEN** a platform message ID already exists for the same bot profile
- **THEN** the system acknowledges the duplicate without creating another agent turn or another delivery

#### Scenario: Worker restarts during processing
- **WHEN** a worker lease expires after a process interruption
- **THEN** the system recovers the persisted state without creating an additional conversation message for a completed run

### Requirement: Channel replies contain only safe presentation content
The system MUST derive outbound replies from final assistant presentation text and MUST NOT expose hidden reasoning, tool traces, secrets, internal paths, or unrequested raw mail bodies.

#### Scenario: Agent emits reasoning and final text
- **WHEN** an agent run contains reasoning, tool events, and a final assistant answer
- **THEN** the channel delivery contains the sanitized final answer and omits the reasoning and tool payloads

#### Scenario: Reply exceeds platform limit
- **WHEN** a final reply is longer than the configured channel message limit
- **THEN** the system splits it deterministically into bounded ordered deliveries

### Requirement: Feishu processing is acknowledged with a native reaction
The system SHALL add Feishu's native `OnIt` reaction to the accepted inbound message immediately before approval or agent processing and SHALL remove that reaction when processing finishes. Reaction failures MUST NOT fail, retry, or duplicate the underlying agent or mail action.

#### Scenario: Authorized Feishu message starts processing
- **WHEN** a Feishu message passes binding, sender, and group-mention checks
- **THEN** Bot Core adds `OnIt` to that exact platform message ID without sending a standalone emoji message

#### Scenario: Feishu processing finishes or fails
- **WHEN** approval interception or agent processing reaches a terminal result
- **THEN** Bot Core removes only the reaction previously added by this bot

#### Scenario: WeCom message starts processing
- **WHEN** an accepted message arrives from WeCom, whose bot protocol does not expose message reactions
- **THEN** the system does not send a standalone emoji or text message pretending to be a reaction

#### Scenario: Reaction delivery fails
- **WHEN** Feishu rejects or times out an add/remove reaction request
- **THEN** the system continues the authorized channel task and does not rerun the agent or mail action

### Requirement: Channel access policies fail closed
The system SHALL enforce enabled connection state, enabled binding state, sender allowlists, group policy, mention requirements, request rate limits, and payload limits before agent execution.

#### Scenario: Group message does not mention the bot
- **WHEN** a binding requires mention gating and the normalized group event does not mention the bot
- **THEN** the system records an ignored outcome and does not invoke the agent

#### Scenario: Sender exceeds rate limit
- **WHEN** an otherwise authorized sender exceeds the configured request rate
- **THEN** the system rejects or defers the event without starting another agent run

### Requirement: Risky actions require binding-scoped confirmation
The system MUST preserve the existing pending-action policy except for a verified WeCom owner's preauthorized direct-chat email send and SHALL allow approval or denial only from the same currently authorized binding that initiated the action.

#### Scenario: Verified WeCom owner confirms a mail preview in direct chat
- **WHEN** the immediately preceding assistant turn contains a marked mail preview and asks for confirmation or revisions, and the verified owner responds with unambiguous natural-language approval that produces a pending action of type `send` or `schedule_send`
- **THEN** the system revalidates the active Profile, Bot, owner identity, direct-chat binding, account ownership, and preview confirmation, executes the exact proposed snapshot once, resolves the pending record, records an audit event, and does not create an approval reference or application confirmation

#### Scenario: Agent emits stale confirmation text after execution
- **WHEN** the preauthorized action has completed but the Agent stream also emits text claiming the action is waiting for confirmation or a confirmation card
- **THEN** the channel discards that stale Agent text and delivers only the authoritative execution success or failure summary

#### Scenario: Model proposes send before preview confirmation
- **WHEN** a verified WeCom owner run produces `send` or `schedule_send` without a qualifying prior preview and current approval
- **THEN** the system rejects and resolves that proposal without execution or an application confirmation and instructs the conversation to save a draft and show the marked preview first

#### Scenario: Preauthorized send scope does not match
- **WHEN** the action is from a group, Feishu, a non-owner identity, another account, or has a risky type other than `send` or `schedule_send`
- **THEN** the system does not use owner send preauthorization and retains the binding-scoped confirmation flow

#### Scenario: Agent proposes a risky action
- **WHEN** a channel-originated run produces a pending action that requires confirmation
- **THEN** the system sends a safe action summary and opaque approval reference without executing the mutation

#### Scenario: Initiating user approves
- **WHEN** the same enabled binding sends `/approve <reference>` for an unresolved action
- **THEN** the system revalidates account ownership, resolves the action through the existing confirmation executor, and delivers the result

#### Scenario: Different user attempts approval
- **WHEN** another sender, chat, bot, or connection submits the approval reference
- **THEN** the system denies the request and leaves the action unresolved

#### Scenario: Initiating user denies
- **WHEN** the same enabled binding sends `/deny <reference>`
- **THEN** the system records the denial without executing the mutation

### Requirement: Phase-one media behavior is explicit
The system SHALL process text and mention metadata in phase one and SHALL represent unsupported media without downloading or executing it.

#### Scenario: Message includes an unsupported attachment
- **WHEN** a supported event contains a file, image, audio, or rich element that phase one does not accept
- **THEN** the system supplies a safe unsupported-content marker or response and does not fetch the remote content
