# Feishu Delivery Target Design

## Problem

WeMail receives a Feishu direct message with both a conversation `chat_id`
(`oc_...`) and a sender `open_id` (`ou_...`). Owner pairing correctly stores
the sender as the owner, but initialization and diagnostic deliveries target
that `open_id` through `FeishuChannel.sendMessage()`. The adapter interprets
its argument as a `chat_id`, so the request uses the wrong
`receive_id_type`.

The adapter's non-proactive send path also logs HTTP failures without throwing.
The Bot Core therefore reports success and WeMail persists the delivery as
`sent` even when Feishu rejected it.

## Goals

- Send person deliveries with Feishu `receive_id_type=open_id`.
- Send group deliveries with Feishu `receive_id_type=chat_id`.
- Treat Feishu API rejection or network failure as a failed delivery instead
  of recording a false success.
- Preserve the existing durable delivery, retry, pairing, and owner-binding
  behavior.
- Keep WeCom behavior unchanged.

## Considered Approaches

### Carry the target type through Bot Core

Add the existing `ChannelDelivery.targetType` (`person` or `group`) to the
runtime transport and Bot Core request. The Feishu channel converts that
explicit type into the adapter's proactive-delivery target semantics.

This is the selected approach because the delivery already knows its target
kind, the protocol becomes unambiguous, and the adapter's proactive path
throws classified errors.

### Resolve every person delivery to its saved conversation ID

Look up the paired `oc_...` conversation and continue using `chat_id`.
This minimizes protocol changes, but it couples delivery to binding history and
cannot safely represent an arbitrary verified person destination.

### Send directly with the Lark SDK

Implement message creation in WeMail's Feishu subclass. This provides full
control but duplicates authentication, card formatting, chunking, and error
classification already present in the channel adapter.

## Design

### Shared protocol

`bot-core.send` gains a required `targetType: "person" | "group"` field. The
Bot Core protocol version is incremented because the main process and utility
process must agree on the request shape.

### Server and main-process transport

`ChannelWorker` passes `delivery.targetType` into `BotChannelRuntime.send()`.
The runtime transport contract and `BotCoreSupervisor.send()` forward it
without inferring from ID prefixes.

### Bot Core channel transport

The managed transport accepts the target ID, target type, and text.

For Feishu, the WeMail subclass exposes a delivery method backed by the
adapter's protected proactive-delivery path:

- `person`: construct a non-group target so the adapter uses `open_id`.
- `group`: construct a group target so the adapter uses `chat_id`.

The target object supplies the channel name and uses the target ID as the
sender ID only where the adapter contract requires a value; routing is
controlled by `chatId` plus `isGroup`.

For WeCom, the existing `sendMessage()` call remains unchanged because its
adapter already receives the target kind through its platform-specific API
semantics.

### Failure behavior

The Feishu proactive-delivery path throws on:

- missing access token;
- non-success HTTP status;
- network or timeout errors.

Those errors propagate through Bot Core and the existing runtime translation
into `ChannelWorker`, which records a retryable or terminal delivery failure
using the current durable-queue policy. A failed initialization therefore
keeps onboarding out of the ready state, and a failed diagnostic message is no
longer reported as sent.

No credentials, message bodies, or platform response payloads are added to
logs.

## Testing

- Extend Bot Core channel tests with a Feishu subclass/transport seam proving:
  - person delivery uses the proactive `open_id` route;
  - group delivery uses the `chat_id` route;
  - adapter rejection is propagated.
- Update supervisor/protocol tests for the required target type and protocol
  version.
- Update `BotChannelRuntime` and `ChannelWorker` tests to assert that
  `targetType` reaches the transport.
- Run the focused channel tests, `npm run typecheck:server`, and
  `npm run typecheck:desktop`.
- Because Electron main, utility-process protocol, and desktop startup are
  touched, run `npm run build:desktop`.

## Compatibility

This is an internal protocol change shipped atomically with both Electron
processes. Existing database rows already contain `target_type`, so no
migration or data rewrite is required.
