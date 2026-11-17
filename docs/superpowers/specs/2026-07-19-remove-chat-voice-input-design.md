# Remove Chat Voice Input

## Goal

Remove all voice-input affordances and dormant voice-input extension points from
the chat composers. The text submission, queued follow-up, stop-generation, IME,
and draft persistence behavior must remain unchanged.

## Scope

### AgentComposer

- Remove the `MicrophoneIcon` import.
- Remove the disabled voice-input button from the composer footer.
- Keep the footer layout, keyboard hint, stop button, and send button intact.

### AskBox

- Remove the `MicrophoneIcon` import.
- Remove the optional `onMicClick` property from `AskBoxProps`.
- Remove `onMicClick` from component argument destructuring.
- Remove the conditional microphone button rendering.
- Update component documentation so it no longer describes an optional
  microphone button.

## Compatibility

No current caller passes `onMicClick`, so removing the property does not require
caller migration. No backend, shared contract, desktop bridge, or speech
recognition behavior is involved.

## Testing

Use test-driven development:

1. Add a focused `AgentComposer` test asserting that no button named `Voice` is
   rendered, and verify that it fails against the current implementation.
2. Remove the voice-input code from both components.
3. Run the focused `AgentComposer` and `AskBox` component tests.
4. Run the repository TypeScript typecheck to catch stale `onMicClick` usage or
   import errors.

## Success Criteria

- No microphone button is rendered by either chat composer.
- No `MicrophoneIcon`, `onMicClick`, `ask-box-mic`, or `Voice input` reference
  remains in the chat composer source.
- Existing text-entry and submission tests continue to pass.
- TypeScript typechecking succeeds.
